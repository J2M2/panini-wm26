import {
  ApiError,
  addSticker,
  executeTrade,
  getAnalytics,
  getDuplicatesCompact,
  getDuplicatesList,
  getMetrics,
  getMissingCompact,
  getMissingList,
  getStickerByRef,
  getSnapshot,
  importSnapshot,
  listsPrintUrl,
  openPack,
  patchSession,
  removeSticker,
} from "./api";
import { STICKERS_PER_PACK } from "./constants";
import {
  canonicalRef,
  expandRefsFromLine,
  parseBatchStickerLines,
  parseRefLines,
  stickerPathFromRef,
  totalBatchCount,
} from "./parseRefs";
import type { ListStickerRow } from "./types";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Record<string, string | boolean>,
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") node.className = String(v);
      else if (k.startsWith("data-")) node.setAttribute(k, String(v));
      else if (typeof v === "boolean") {
        if (v) node.setAttribute(k, "");
      } else (node as HTMLElement).setAttribute(k, String(v));
    }
  }
  for (const c of children) {
    if (typeof c === "string") node.appendChild(document.createTextNode(c));
    else if (c) node.appendChild(c);
  }
  return node;
}

const views: Record<string, HTMLElement> = {};

/** Canonical missing refs (qty === 0). */
let tradeMissingRefs: Set<string> | null = null;
/** Canonical ref → qty/spares for stickers with qty > 1. */
let tradeDupMap: Map<string, { qty: number; spare: number }> | null = null;
/** Set when missing/duplicate list fetch fails — preview cannot run until fixed. */
let tradePreviewLoadError: string | null = null;

let tradeDupRows: ListStickerRow[] = [];

async function loadTradePreviewData(): Promise<void> {
  tradePreviewLoadError = null;
  try {
    const [missing, dups] = await Promise.all([getMissingList(), getDuplicatesList()]);
    tradeMissingRefs = new Set(missing.map((r) => canonicalRef(r.ref)));
    tradeDupRows = dups;
    tradeDupMap = new Map(
      dups.map((r) => {
        const c = canonicalRef(r.ref);
        const spare = r.spare_copies ?? Math.max(0, r.qty - 1);
        return [c, { qty: r.qty, spare }];
      }),
    );
    renderTradeDupPicker();
    document.getElementById("trade-give")?.dispatchEvent(new Event("input"));
  } catch (e) {
    tradeMissingRefs = null;
    tradeDupMap = null;
    tradeDupRows = [];
    tradePreviewLoadError = e instanceof Error ? e.message : String(e);
    const box = document.getElementById("trade-dup-picker");
    if (box) box.textContent = "Could not load lists.";
    document.getElementById("trade-give")?.dispatchEvent(new Event("input"));
  }
}

function renderTradeDupPicker(): void {
  const box = document.getElementById("trade-dup-picker");
  if (!box) return;
  try {
    box.innerHTML = "";
    const tbl = el("table", { class: "data" });
    const thead = el("thead", {}, el("tr", {}, el("th", {}, "ref"), el("th", {}, "spares")));
    const tbody = el("tbody");
    for (const r of tradeDupRows.slice(0, 80)) {
      const tr = el("tr", { style: "cursor:pointer" });
      tr.appendChild(el("td", { class: "ref" }, r.ref));
      tr.appendChild(el("td", {}, String(r.spare_copies ?? r.qty - 1)));
      tr.title = "Click to append to Give";
      tr.addEventListener("click", () => {
        const ta = document.getElementById("trade-give") as HTMLTextAreaElement | null;
        if (!ta) return;
        const lines = parseRefLines(ta.value);
        lines.push(r.ref);
        ta.value = `${lines.join("\n")}\n`;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      });
      tbody.appendChild(tr);
    }
    tbl.append(thead, tbody);
    box.appendChild(tbl);
    if (tradeDupRows.length > 80) {
      box.appendChild(
        el("p", { style: "font-size:0.85rem;color:var(--muted)" }, `Showing 80 of ${tradeDupRows.length}. See Lists for full table.`),
      );
    }
  } catch {
    box.textContent = "Could not render duplicates.";
  }
}

export function initApp(root: HTMLElement): void {
  root.innerHTML = "";
  const sidebar = el("nav", { class: "sidebar" });
  sidebar.appendChild(el("h1", {}, "Panini WM26"));
  const routes = [
    ["overview", "Overview"],
    ["lists", "Lists"],
    ["desk", "Sticker desk"],
    ["pack", "Pack"],
    ["trade", "Trade"],
  ] as const;
  for (const [id, label] of routes) {
    const b = el("button", { class: "nav-btn", type: "button", "data-route": id }, label);
    if (id === "overview") b.classList.add("active");
    b.addEventListener("click", () => showView(id));
    sidebar.appendChild(b);
  }

  const main = el("main", {});
  main.appendChild(buildOverview());
  main.appendChild(buildLists());
  main.appendChild(buildDesk());
  main.appendChild(buildPack());
  main.appendChild(buildTrade());

  root.appendChild(sidebar);
  root.appendChild(main);
}

function showView(id: string): void {
  document.querySelectorAll(".nav-btn").forEach((b) => {
    b.classList.toggle("active", (b as HTMLElement).dataset.route === id);
  });
  Object.entries(views).forEach(([k, section]) => {
    section.classList.toggle("active", k === id);
  });
  if (id === "trade") {
    void loadTradePreviewData();
  }
}

function buildOverview(): HTMLElement {
  const section = el("section", { class: "view active", id: "view-overview" });
  views.overview = section;
  section.appendChild(el("h2", {}, "Overview"));

  const metricsHost = el("div", { class: "card" });
  const analyticsHost = el("div", { class: "card" });
  const sessionHost = el("div", { class: "card" });
  const ioHost = el("div", { class: "card" });

  section.append(metricsHost, analyticsHost, sessionHost, ioHost);

  const sessionInputs = {
    packs: el("input", { type: "number", min: "0" }) as HTMLInputElement,
    out: el("input", { type: "number", min: "0" }) as HTMLInputElement,
    inn: el("input", { type: "number", min: "0" }) as HTMLInputElement,
  };
  const sessionMsg = el("div", { class: "msg-ok" });
  const sessionErr = el("div", { class: "msg-error" });

  async function loadMetrics(): Promise<void> {
    metricsHost.innerHTML = "<p class='muted'>Loading…</p>";
    analyticsHost.innerHTML = "";
    try {
      const m = await getMetrics();
      metricsHost.innerHTML = "";
      metricsHost.appendChild(el("h3", {}, "Collection"));
      const g = el("div", { class: "grid-metrics" });
      const cells: [string, string][] = [
        ["Complete (unique)", `${m.pct_complete_unique}%`],
        ["Filled slots", String(m.unique_slots_filled)],
        ["Missing", String(m.unique_slots_missing)],
        ["Spares", String(m.spare_copies)],
        ["Physical total", String(m.total_physical_stickers)],
      ];
      for (const [label, val] of cells) {
        g.appendChild(
          el("div", { class: "metric" }, el("div", { class: "label" }, label), el("div", { class: "value" }, val)),
        );
      }
      metricsHost.appendChild(g);

      sessionInputs.packs.value = String(m.session.packs_opened);
      sessionInputs.out.value = String(m.session.traded_out_count);
      sessionInputs.inn.value = String(m.session.traded_in_count);

      const an = await getAnalytics();
      analyticsHost.appendChild(el("h3", {}, "Analytics"));
      const pre = el("pre", {
        style: "margin:0;font-size:0.85rem;overflow:auto;max-height:200px;color:var(--muted)",
      });
      pre.textContent = JSON.stringify(an, null, 2);
      analyticsHost.appendChild(pre);
    } catch (e) {
      metricsHost.innerHTML = "";
      metricsHost.appendChild(errBox(e));
    }
  }

  sessionHost.appendChild(el("h3", {}, "Session counters"));
  sessionHost.appendChild(
    el("p", { style: "font-size:0.9rem;color:var(--muted)" }, "Adjust notes to match your tracking (also updated by pack/trade actions)."),
  );
  const sg = el("div", { class: "session-grid" });
  sg.appendChild(
    el("div", {}, el("label", { class: "field" }, "Packs opened"), sessionInputs.packs),
  );
  sg.appendChild(
    el("div", {}, el("label", { class: "field" }, "Traded out"), sessionInputs.out),
  );
  sg.appendChild(
    el("div", {}, el("label", { class: "field" }, "Traded in"), sessionInputs.inn),
  );
  sessionHost.appendChild(sg);
  const saveSession = el("button", { class: "btn btn-primary", type: "button" }, "Save session");
  saveSession.addEventListener("click", async () => {
    sessionMsg.textContent = "";
    sessionErr.textContent = "";
    try {
      await patchSession({
        packs_opened: parseInt(sessionInputs.packs.value, 10) || 0,
        traded_out_count: parseInt(sessionInputs.out.value, 10) || 0,
        traded_in_count: parseInt(sessionInputs.inn.value, 10) || 0,
      });
      sessionMsg.textContent = "Saved.";
    } catch (e) {
      sessionErr.replaceChildren(errBox(e));
    }
  });
  sessionHost.appendChild(saveSession);
  sessionHost.appendChild(sessionMsg);
  sessionHost.appendChild(sessionErr);

  ioHost.appendChild(el("h3", {}, "Import / export"));
  const ioRow = el("div", { class: "row" });
  const exportBtn = el("button", { class: "btn btn-primary", type: "button" }, "Download snapshot JSON");
  exportBtn.addEventListener("click", async () => {
    try {
      const snap = await getSnapshot();
      const blob = new Blob([JSON.stringify(snap, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `panini_snapshot_${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      alert(String(e instanceof Error ? e.message : e));
    }
  });
  const printLink = el("a", { href: listsPrintUrl(), target: "_blank", rel: "noopener" }, "Open printable sheet");
  ioRow.append(exportBtn, printLink);
  ioHost.appendChild(ioRow);

  const applySess = el("input", { type: "checkbox" }) as HTMLInputElement;
  applySess.checked = true;
  const fileInput = el("input", { type: "file", accept: ".json,application/json" }) as HTMLInputElement;
  const importMsg = el("div", { class: "msg-ok" });
  const importErr = el("div", { class: "msg-error" });
  fileInput.addEventListener("change", async () => {
    importMsg.textContent = "";
    importErr.textContent = "";
    const f = fileInput.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      await importSnapshot(body, applySess.checked);
      importMsg.textContent = "Import applied.";
      await loadMetrics();
    } catch (e) {
      importErr.appendChild(errBox(e));
    }
    fileInput.value = "";
  });
  ioHost.appendChild(
    el("div", { class: "checkbox-row" }, applySess, el("label", {}, "Restore session from file (if present)")),
  );
  ioHost.appendChild(el("label", { class: "field" }, "Import snapshot JSON"));
  ioHost.appendChild(fileInput);
  ioHost.appendChild(importMsg);
  ioHost.appendChild(importErr);

  const refresh = el("button", { class: "btn", type: "button" }, "Refresh");
  refresh.addEventListener("click", () => loadMetrics());
  section.insertBefore(refresh, metricsHost);

  loadMetrics();
  return section;
}

function errBox(e: unknown): HTMLElement {
  const msg = e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e);
  return el("div", { class: "msg-error" }, msg);
}

function buildLists(): HTMLElement {
  const section = el("section", { class: "view", id: "view-lists" });
  views.lists = section;
  section.appendChild(el("h2", {}, "Missing & duplicates"));

  const missHost = el("div", { class: "card" });
  const dupHost = el("div", { class: "card" });

  let missingRows: ListStickerRow[] = [];
  let dupRows: ListStickerRow[] = [];
  let missSort: { key: keyof ListStickerRow; dir: number } = { key: "ref", dir: 1 };
  let dupSort: { key: keyof ListStickerRow; dir: number } = { key: "ref", dir: 1 };

  function sortRows<T extends ListStickerRow>(rows: T[], sort: { key: keyof T; dir: number }): T[] {
    const k = sort.key;
    return [...rows].sort((a, b) => {
      const va = a[k as keyof T];
      const vb = b[k as keyof T];
      const cmp =
        typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va).localeCompare(String(vb));
      return cmp * sort.dir;
    });
  }

  function renderMissing(): void {
    const sorted = sortRows(missingRows, missSort);
    missHost.innerHTML = "";
    missHost.appendChild(el("h3", {}, "Missing"));
    const tb = tableFromRows(
      sorted,
      ["ref", "category_code", "slot_code", "qty"] as const,
      missSort,
      (s) => {
        missSort = s;
        renderMissing();
      },
    );
    missHost.appendChild(tb);
  }

  function renderDup(): void {
    const sorted = sortRows(dupRows, dupSort);
    dupHost.innerHTML = "";
    dupHost.appendChild(el("h3", {}, "Duplicates"));
    const tb = tableFromRows(
      sorted,
      ["ref", "qty", "spare_copies"] as const,
      dupSort,
      (s) => {
        dupSort = s;
        renderDup();
      },
    );
    dupHost.appendChild(tb);
  }

  async function load(): Promise<void> {
    missHost.textContent = "Loading…";
    dupHost.textContent = "";
    try {
      missingRows = await getMissingList();
      dupRows = await getDuplicatesList();
      renderMissing();
      renderDup();
    } catch (e) {
      missHost.innerHTML = "";
      missHost.appendChild(errBox(e));
    }
  }

  const row = el("div", { class: "row" });
  row.appendChild(el("button", { class: "btn btn-primary", type: "button" }, "Reload")).addEventListener(
    "click",
    () => load(),
  );
  const copyMiss = el("button", { class: "btn", type: "button" }, "Copy missing (compact)");
  copyMiss.addEventListener("click", async () => {
    try {
      const t = await getMissingCompact();
      await navigator.clipboard.writeText(t);
      copyMiss.textContent = "Copied!";
      setTimeout(() => {
        copyMiss.textContent = "Copy missing (compact)";
      }, 1500);
    } catch (e) {
      alert(String(e));
    }
  });
  const copyDup = el("button", { class: "btn", type: "button" }, "Copy duplicates (compact)");
  copyDup.addEventListener("click", async () => {
    try {
      const t = await getDuplicatesCompact();
      await navigator.clipboard.writeText(t);
      copyDup.textContent = "Copied!";
      setTimeout(() => {
        copyDup.textContent = "Copy duplicates (compact)";
      }, 1500);
    } catch (e) {
      alert(String(e));
    }
  });
  row.append(copyMiss, copyDup);
  section.appendChild(row);
  section.append(missHost, dupHost);
  load();
  return section;
}

function tableFromRows<T extends object>(
  rows: T[],
  cols: (keyof T)[],
  sort: { key: keyof T; dir: number },
  onSort: (s: { key: keyof T; dir: number }) => void,
): HTMLElement {
  const table = el("table", { class: "data" });
  const thead = el("thead");
  const thr = el("tr");
  for (const c of cols) {
    const col = c;
    const th = el("th", {}, String(col));
    th.addEventListener("click", () => {
      const dir = sort.key === col ? -sort.dir : 1;
      onSort({ key: col, dir });
    });
    thr.appendChild(th);
  }
  thead.appendChild(thr);
  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    for (const c of cols) {
      const td = el("td", { class: c === "ref" ? "ref" : "" }, String(r[c] ?? ""));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.append(thead, tbody);
  return table;
}

function buildDesk(): HTMLElement {
  const section = el("section", { class: "view", id: "view-desk" });
  views.desk = section;
  section.appendChild(el("h2", {}, "Sticker desk"));

  const lookupCard = el("div", { class: "card" });
  const refInput = el("input", {
    type: "text",
    placeholder: "MEX:5 · FWC 14 · MEX: 1, 2, 3",
  }) as HTMLInputElement;
  const lookupOut = el("pre", {
    style: "margin:0.5rem 0;font-size:0.85rem;color:var(--muted);white-space:pre-wrap",
  });
  const lookupErr = el("div", { class: "msg-error" });
  lookupCard.appendChild(el("h3", {}, "Lookup"));
  lookupCard.appendChild(el("label", { class: "field" }, "Sticker ref"));
  lookupCard.appendChild(refInput);
  const lookupBtn = el("button", { class: "btn btn-primary", type: "button" }, "Look up");
  lookupBtn.addEventListener("click", async () => {
    lookupOut.textContent = "";
    lookupErr.textContent = "";
    try {
      const expanded = expandRefsFromLine(refInput.value.trim());
      if (expanded.length === 0) {
        lookupErr.textContent = "Enter a sticker ref.";
        return;
      }
      if (expanded.length > 1) {
        lookupErr.appendChild(
          el(
            "div",
            { class: "banner-info" },
            `Showing the first of ${expanded.length} stickers (${expanded.slice(0, 8).join(", ")}${expanded.length > 8 ? ", …" : ""}).`,
          ),
        );
      }
      const r = await getStickerByRef(expanded[0]!);
      lookupOut.textContent = JSON.stringify(r, null, 2);
    } catch (e) {
      lookupErr.replaceChildren(errBox(e));
    }
  });
  lookupCard.appendChild(lookupBtn);
  lookupCard.appendChild(lookupErr);
  lookupCard.appendChild(lookupOut);

  const addCard = el("div", { class: "card" });
  addCard.appendChild(el("h3", {}, "Add stickers"));
  const batchAdd = el("textarea", {
    placeholder: `MEX:5\nFWC 14\nRSA 7\nMEX: 1, 2, 3\nFWC:12 x3`,
  }) as HTMLTextAreaElement;
  const addPreview = el("div", { class: "compact-list" });
  const addMsg = el("div");
  batchAdd.addEventListener("input", () => {
    try {
      const rows = parseBatchStickerLines(batchAdd.value);
      const total = totalBatchCount(rows);
      const packs = Math.ceil(total / STICKERS_PER_PACK);
      addPreview.textContent = `${rows.length} line(s), ${total} sticker(s) (~${packs} packs if uniform).`;
    } catch {
      addPreview.textContent = "";
    }
  });
  const applyAdd = el("button", { class: "btn btn-primary", type: "button" }, "Apply adds");
  const suggestPacksBtn = el("button", { class: "btn", type: "button" }, `Add ~packs to session (${STICKERS_PER_PACK}/pack)`);
  suggestPacksBtn.title = "After adds: increment packs_opened by ceil(N/7). Run once after Apply adds.";
  let lastAddTotal = 0;

  applyAdd.addEventListener("click", async () => {
    addMsg.innerHTML = "";
    try {
      const rows = parseBatchStickerLines(batchAdd.value);
      lastAddTotal = totalBatchCount(rows);
      for (const { ref, count } of rows) {
        stickerPathFromRef(ref); // validate
        await addSticker(ref, count);
      }
      addMsg.appendChild(el("div", { class: "msg-ok" }, `Added ${lastAddTotal} sticker instance(s).`));
    } catch (e) {
      addMsg.appendChild(errBox(e));
    }
  });

  suggestPacksBtn.addEventListener("click", async () => {
    addMsg.innerHTML = "";
    if (lastAddTotal <= 0) {
      addMsg.appendChild(el("div", { class: "banner-info" }, "Use Apply adds first, or enter a total manually via Overview → session."));
      return;
    }
    const delta = Math.ceil(lastAddTotal / STICKERS_PER_PACK);
    try {
      const m = await getMetrics();
      const newPacks = m.session.packs_opened + delta;
      await patchSession({ packs_opened: newPacks });
      addMsg.appendChild(
        el(
          "div",
          { class: "msg-ok" },
          `packs_opened is now ${newPacks} (+${delta} from previous ${m.session.packs_opened}).`,
        ),
      );
    } catch (e) {
      addMsg.appendChild(errBox(e));
    }
  });

  addCard.appendChild(el("label", { class: "field" }, "Batch (optional: REF x3)"));
  addCard.appendChild(batchAdd);
  addCard.appendChild(addPreview);
  addCard.appendChild(el("div", { class: "row" }, applyAdd, suggestPacksBtn));
  addCard.appendChild(addMsg);

  const remCard = el("div", { class: "card" });
  remCard.appendChild(el("h3", {}, "Remove stickers"));
  const batchRem = el("textarea", { placeholder: "Same format as add" }) as HTMLTextAreaElement;
  const remMsg = el("div");
  const applyRem = el("button", { class: "btn btn-primary", type: "button" }, "Apply removes");
  applyRem.addEventListener("click", async () => {
    remMsg.innerHTML = "";
    try {
      const rows = parseBatchStickerLines(batchRem.value);
      for (const { ref, count } of rows) {
        stickerPathFromRef(ref);
        await removeSticker(ref, count);
      }
      remMsg.appendChild(el("div", { class: "msg-ok" }, `Removed ${totalBatchCount(rows)} sticker instance(s).`));
    } catch (e) {
      remMsg.appendChild(errBox(e));
    }
  });
  remCard.appendChild(el("label", { class: "field" }, "Batch"));
  remCard.appendChild(batchRem);
  remCard.appendChild(applyRem);
  remCard.appendChild(remMsg);

  const singleCard = el("div", { class: "card" });
  singleCard.appendChild(el("h3", {}, "Single add / remove"));
  const sRef = el("input", { type: "text", placeholder: "MEX:5" }) as HTMLInputElement;
  const sCount = el("input", { type: "number", min: "1", value: "1" }) as HTMLInputElement;
  const singleMsg = el("div");
  singleCard.appendChild(el("div", { class: "row" }));
  singleCard.querySelector(".row")!.appendChild(el("div", {}, el("label", { class: "field" }, "Ref"), sRef));
  singleCard.querySelector(".row")!.appendChild(el("div", {}, el("label", { class: "field" }, "Count"), sCount));
  const bAdd = el("button", { class: "btn", type: "button" }, "Add");
  const bRem = el("button", { class: "btn", type: "button" }, "Remove");
  bAdd.addEventListener("click", async () => {
    singleMsg.innerHTML = "";
    try {
      await addSticker(sRef.value.trim(), parseInt(sCount.value, 10) || 1);
      singleMsg.appendChild(el("div", { class: "msg-ok" }, "OK"));
    } catch (e) {
      singleMsg.appendChild(errBox(e));
    }
  });
  bRem.addEventListener("click", async () => {
    singleMsg.innerHTML = "";
    try {
      await removeSticker(sRef.value.trim(), parseInt(sCount.value, 10) || 1);
      singleMsg.appendChild(el("div", { class: "msg-ok" }, "OK"));
    } catch (e) {
      singleMsg.appendChild(errBox(e));
    }
  });
  singleCard.appendChild(el("div", { class: "row" }, bAdd, bRem));
  singleCard.appendChild(singleMsg);

  section.append(lookupCard, addCard, remCard, singleCard);
  return section;
}

function buildPack(): HTMLElement {
  const section = el("section", { class: "view", id: "view-pack" });
  views.pack = section;
  section.appendChild(el("h2", {}, "Open pack"));
  const card = el("div", { class: "card" });
  const ta = el("textarea", {
    placeholder: `One ref per line (${STICKERS_PER_PACK} lines for a full pack)`,
  }) as HTMLTextAreaElement;
  const perPack = el("input", {
    type: "number",
    min: "1",
    max: "50",
    value: String(STICKERS_PER_PACK),
  }) as HTMLInputElement;
  const out = el("pre", {
    style: "margin:0.75rem 0;font-size:0.85rem;color:var(--muted);white-space:pre-wrap",
  });
  const btn = el("button", { class: "btn btn-primary", type: "button" }, "Register pack");
  btn.addEventListener("click", async () => {
    out.textContent = "";
    try {
      const stickers = parseRefLines(ta.value);
      const r = await openPack(stickers, parseInt(perPack.value, 10) || STICKERS_PER_PACK);
      out.textContent = JSON.stringify(r, null, 2);
    } catch (e) {
      out.replaceChildren(errBox(e));
    }
  });
  card.appendChild(el("p", { style: "font-size:0.9rem;color:var(--muted)" }, `Default ${STICKERS_PER_PACK} stickers per pack.`));
  card.appendChild(el("label", { class: "field" }, "Stickers"));
  card.appendChild(ta);
  card.appendChild(el("label", { class: "field" }, "per_pack"));
  card.appendChild(perPack);
  card.appendChild(btn);
  card.appendChild(out);
  section.appendChild(card);
  return section;
}

function formatPreviewRefList(refs: string[], max = 20): string {
  const u = [...new Set(refs)];
  u.sort();
  if (u.length <= max) return u.join(", ");
  return `${u.slice(0, max).join(", ")} (+${u.length - max} more)`;
}

function buildTrade(): HTMLElement {
  const section = el("section", { class: "view", id: "view-trade" });
  views.trade = section;
  section.appendChild(el("h2", {}, "Trade"));

  const giveTa = el("textarea", { id: "trade-give", placeholder: "Stickers you give (one per line)" }) as HTMLTextAreaElement;
  const takeTa = el("textarea", { id: "trade-take", placeholder: "Stickers you receive" }) as HTMLTextAreaElement;
  const strictCb = el("input", { type: "checkbox" }) as HTMLInputElement;
  const unevenCb = el("input", { type: "checkbox" }) as HTMLInputElement;
  const countBadge = el("span", { class: "badge" }, "0 ↔ 0");
  countBadge.title =
    "Parsed sticker refs after comma expansion — not just visible lines. Scroll each box to see every line.";
  const infoUneven = el("div", {
    class: "banner-info",
    style: "display:none",
  });
  infoUneven.textContent =
    "Different numbers of stickers — swaps are usually even. You can enable “Allow uneven” below if this trade is intentional.";

  const previewCard = el("div", { class: "card trade-preview-card" });
  previewCard.appendChild(el("h3", {}, "Preview"));
  const previewHost = el("div", { class: "trade-preview-host", id: "trade-preview-host" });

  function updateTradePreview(): void {
    let give: string[] = [];
    let take: string[] = [];
    try {
      give = parseRefLines(giveTa.value);
      take = parseRefLines(takeTa.value);
    } catch (e) {
      previewHost.innerHTML = "";
      previewHost.appendChild(errBox(e));
      countBadge.textContent = "— ↔ —";
      infoUneven.style.display = "none";
      return;
    }

    countBadge.textContent = `${give.length} ↔ ${take.length}`;
    infoUneven.style.display = give.length !== take.length ? "block" : "none";

    previewHost.innerHTML = "";

    if (tradePreviewLoadError) {
      previewHost.appendChild(
        el(
          "div",
          { class: "banner-error", style: "margin-bottom:0.5rem" },
          `Preview needs album lists: ${tradePreviewLoadError}`,
        ),
      );
      previewHost.appendChild(
        el(
          "p",
          { style: "margin:0;font-size:0.85rem;color:var(--muted)" },
          "Check that the API is running and the database is reachable. Open Lists — if that fails too, fix the server first.",
        ),
      );
      return;
    }

    if (!tradeMissingRefs || !tradeDupMap) {
      previewHost.appendChild(
        el("p", { style: "margin:0;font-size:0.9rem;color:var(--muted)" }, "Loading album data for preview…"),
      );
      return;
    }

    previewHost.appendChild(el("p", { class: "trade-preview-summary" }, `${give.length} ↔ ${take.length}`));

    const giveNoHave: string[] = [];
    const giveLast: string[] = [];
    const giveSpare: string[] = [];

    for (const raw of give) {
      try {
        stickerPathFromRef(raw);
        const c = canonicalRef(raw);
        if (tradeMissingRefs.has(c)) giveNoHave.push(c);
        else if (tradeDupMap.has(c)) giveSpare.push(c);
        else giveLast.push(c);
      } catch {
        /* invalid */
      }
    }

    const takeNeed: string[] = [];
    const takeAlready: string[] = [];
    for (const raw of take) {
      try {
        stickerPathFromRef(raw);
        const c = canonicalRef(raw);
        if (tradeMissingRefs.has(c)) takeNeed.push(c);
        else takeAlready.push(c);
      } catch {
        /* invalid */
      }
    }

    function block(cls: string, title: string, body: string): HTMLElement {
      return el(
        "div",
        { class: `preview-block ${cls}` },
        el("div", { class: "preview-block-title" }, title),
        el("div", { class: "preview-block-body ref" }, body),
      );
    }

    if (giveNoHave.length > 0) {
      previewHost.appendChild(
        block(
          "danger",
          "Give — you don't have these (can't trade away)",
          formatPreviewRefList(giveNoHave),
        ),
      );
    }
    if (giveLast.length > 0) {
      previewHost.appendChild(
        block(
          "warn",
          "Give — last copy only (you'll trade your only sticker)",
          formatPreviewRefList(giveLast),
        ),
      );
    }
    if (giveSpare.length > 0) {
      const lines = [...new Set(giveSpare)].sort().map((r) => {
        const s = tradeDupMap!.get(r)!.spare;
        return `${r} (${s} spare${s === 1 ? "" : "s"})`;
      });
      previewHost.appendChild(
        block("ok", "Give — you have duplicates / spares", lines.join(", ") || "—"),
      );
    }

    if (takeAlready.length > 0) {
      previewHost.appendChild(
        block(
          "info",
          "Receive — already in your album (not on missing list)",
          formatPreviewRefList(takeAlready),
        ),
      );
    }
    if (takeNeed.length > 0) {
      previewHost.appendChild(
        block("need", "Receive — you still need these", formatPreviewRefList(takeNeed)),
      );
    }

    const okGive = giveNoHave.length + giveLast.length + giveSpare.length;
    const okTake = takeNeed.length + takeAlready.length;
    if (give.length > 0 && okGive === 0) {
      previewHost.appendChild(
        block(
          "warn",
          "Give — couldn't classify lines",
          "Check refs use TEAM:SLOT, TEAM SLOT, or comma lists.",
        ),
      );
    }
    if (take.length > 0 && okTake === 0) {
      previewHost.appendChild(
        block(
          "warn",
          "Receive — couldn't classify lines",
          "Check refs use TEAM:SLOT, TEAM SLOT, or comma lists.",
        ),
      );
    }

    if (
      giveNoHave.length === 0 &&
      giveLast.length === 0 &&
      giveSpare.length === 0 &&
      takeAlready.length === 0 &&
      takeNeed.length === 0 &&
      give.length === 0 &&
      take.length === 0 &&
      previewHost.querySelectorAll(".preview-block").length === 0
    ) {
      previewHost.appendChild(
        el("p", { style: "margin:0;font-size:0.9rem;color:var(--muted)" }, "Enter refs above to see an analysis."),
      );
    }
  }

  previewCard.appendChild(previewHost);
  giveTa.addEventListener("input", updateTradePreview);
  takeTa.addEventListener("input", updateTradePreview);

  const submit = el("button", { class: "btn btn-primary", type: "button" }, "Execute trade");
  const result = el("pre", {
    style: "margin:0.75rem 0;font-size:0.85rem;color:var(--muted);white-space:pre-wrap",
  });

  submit.addEventListener("click", async () => {
    result.textContent = "";
    try {
      const give = parseRefLines(giveTa.value);
      const take = parseRefLines(takeTa.value);
      const r = await executeTrade(give, take, strictCb.checked, unevenCb.checked);
      result.textContent = JSON.stringify(r, null, 2);
      await loadTradePreviewData();
    } catch (e) {
      result.replaceChildren(errBox(e));
    }
  });

  const grid = el("div", { class: "trade-grid" });
  grid.appendChild(
    el("div", { class: "card" }, el("h3", {}, "You give"), giveTa, countBadge),
  );
  grid.appendChild(
    el("div", { class: "card" }, el("h3", {}, "You receive"), takeTa),
  );

  section.appendChild(grid);
  section.appendChild(previewCard);
  section.appendChild(infoUneven);
  section.appendChild(
    el("div", { class: "checkbox-row" }, strictCb, el("label", {}, "Strict: only trade duplicates (qty ≥ 2)")),
  );
  section.appendChild(
    el("div", { class: "checkbox-row" }, unevenCb, el("label", {}, "Allow uneven counts")),
  );
  section.appendChild(submit);
  section.appendChild(result);

  const dupCard = el("div", { class: "card" });
  dupCard.appendChild(el("h3", {}, "Duplicates (click row to add to Give)"));
  const dupPicker = el("div", { id: "trade-dup-picker", class: "compact-list" });
  dupCard.appendChild(dupPicker);
  section.appendChild(dupCard);

  updateTradePreview();

  return section;
}
