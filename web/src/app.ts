import {
  ApiError,
  addSticker,
  executeTrade,
  getAnalytics,
  getAnalyticsTeams,
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
  undoTrade,
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
import type { ListStickerRow, StickerDetail, TeamAnalyticsRow, TradeResponse } from "./types";

/** Album-facing ref label (FWC internal 20 → `FWC:00`). */
function albumStickerRefLabel(row: { category_code: string; album_code?: string; ref: string }): string {
  if (row.category_code === "FWC" && row.album_code != null && row.album_code !== "") {
    return `FWC:${row.album_code}`;
  }
  return row.ref;
}

function listStickerDisplayRef(row: ListStickerRow): string {
  return albumStickerRefLabel(row);
}

/** Open Desk → Lookup with `ref` (album-style FWC ok). Set in `buildDesk`. */
let openDeskLookupFromLists: ((ref: string) => Promise<void>) | null = null;

/** Short row type for missing list (shield / photo / FWC special). */
function listStickerRoleTitle(role: ListStickerRow["role"]): string {
  switch (role) {
    case "shield":
      return "Team shield (slot 1)";
    case "team_photo":
      return "Team photo (slot 13)";
    case "fwc_special":
      return "FWC special (album 00)";
    case "fwc":
      return "FWC sticker";
    default:
      return "Player / base slot";
  }
}

function listStickerRoleRefClass(role: ListStickerRow["role"]): string {
  const base = "lists-line-ref ref";
  switch (role) {
    case "shield":
      return `${base} lists-line-ref--shield`;
    case "team_photo":
      return `${base} lists-line-ref--photo`;
    case "fwc_special":
      return `${base} lists-line-ref--fwc-sp`;
    case "fwc":
      return `${base} lists-line-ref--fwc`;
    default:
      return `${base} lists-line-ref--player`;
  }
}

function groupListRowsByCategory(rows: ListStickerRow[]): { code: string; rows: ListStickerRow[] }[] {
  const by = new Map<string, ListStickerRow[]>();
  for (const r of rows) {
    const c = r.category_code;
    if (!by.has(c)) by.set(c, []);
    by.get(c)!.push(r);
  }
  const keys = [...by.keys()].sort((a, b) => {
    if (a === "FWC" && b !== "FWC") return -1;
    if (b === "FWC" && a !== "FWC") return 1;
    return a.localeCompare(b);
  });
  for (const k of keys) {
    by.get(k)!.sort((a, b) => {
      const na = parseInt(a.slot_code, 10);
      const nb = parseInt(b.slot_code, 10);
      return (Number.isNaN(na) ? 0 : na) - (Number.isNaN(nb) ? 0 : nb);
    });
  }
  return keys.map((code) => ({ code, rows: by.get(code)! }));
}

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

/** Full team analytics view: refetch when navigating to Analytics. */
const analyticsPage = {
  reload: async (): Promise<void> => {},
};

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
    ["analytics", "Team analytics"],
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
  main.appendChild(buildAnalytics());
  main.appendChild(buildDesk());
  main.appendChild(buildLists());
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
  if (id === "analytics") {
    void analyticsPage.reload();
  }
  if (id === "trade") {
    void loadTradePreviewData();
  }
}

function _num(x: unknown, fallback = 0): number {
  return typeof x === "number" && !Number.isNaN(x) ? x : fallback;
}

function _str(x: unknown, fallback = ""): string {
  return typeof x === "string" ? x : fallback;
}

function _rec(x: unknown): Record<string, unknown> | null {
  return typeof x === "object" && x !== null && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}

function analyticsPctRing(pct: number, innerLabel?: string): HTMLElement {
  const p = Math.min(100, Math.max(0, pct));
  const outer = el("div", { class: "pct-ring-outer" });
  outer.style.setProperty("--pct", String(p));
  const inner = el("div", { class: "pct-ring-inner" });
  inner.appendChild(el("span", { class: "pct-ring-val" }, `${Math.round(p)}%`));
  if (innerLabel) inner.appendChild(el("span", { class: "pct-ring-sub" }, innerLabel));
  outer.appendChild(inner);
  return outer;
}

function _bool(x: unknown): boolean {
  return x === true;
}

function formatTieNote(note: string): HTMLElement {
  return el("p", { class: "stat-widget__tie" }, note);
}

function analyticsHBar(pct: number): HTMLElement {
  const p = Math.min(100, Math.max(0, pct));
  const track = el("div", { class: "analytics-bar-track" });
  const fill = el("div", { class: "analytics-bar-fill" });
  fill.style.width = `${p}%`;
  track.appendChild(fill);
  return track;
}

/** Rich overview cards from `GET /analytics` (replaces raw JSON dump). */
function renderAnalyticsWidgets(data: Record<string, unknown>): HTMLElement {
  const grid = el("div", { class: "analytics-widget-grid" });

  const repeated = _rec(data.most_repeated);
  if (repeated) {
    const ref = _str(repeated.ref, "?");
    const qty = _num(repeated.qty, 0);
    const album = _str(repeated.album_code, "");
    const sub = album ? `${ref} · album ${album}` : ref;
    const w = el("article", { class: "stat-widget stat-widget--gold" });
    w.appendChild(el("div", { class: "stat-widget__eyebrow" }, "Duplicate champion"));
    w.appendChild(el("div", { class: "stat-widget__hero ref" }, ref));
    w.appendChild(el("div", { class: "stat-widget__metric" }, el("span", { class: "stat-widget__qty" }, `×${qty}`), " in the stack"));
    w.appendChild(el("p", { class: "stat-widget__hint" }, sub));
    grid.appendChild(w);
  }

  const dupTeam = _rec(data.most_duplicated_team);
  if (dupTeam) {
    const code = _str(dupTeam.code, "?");
    const spare = _num(dupTeam.spare_copies, 0);
    const slotsDup = _num(dupTeam.slots_with_duplicates, 0);
    const pctSlots = _num(dupTeam.pct_slots_with_dup, 0);
    const tieNote = _str(dupTeam.tie_note, "");
    const tied = _bool(dupTeam.tied);
    const w = el("article", { class: "stat-widget stat-widget--dup-team" });
    w.appendChild(el("div", { class: "stat-widget__eyebrow" }, "Most duplicated team"));
    w.appendChild(el("div", { class: "stat-widget__hero ref" }, code));
    w.appendChild(
      el(
        "div",
        { class: "stat-widget__metric" },
        el("span", { class: "stat-widget__qty" }, `+${spare}`),
        " spare copies on this page",
      ),
    );
    w.appendChild(
      el(
        "p",
        { class: "stat-widget__hint" },
        `${slotsDup} slot${slotsDup === 1 ? "" : "s"} with qty>1 · sum of extras beyond the first copy each`,
      ),
    );
    if (tied && tieNote) w.appendChild(formatTieNote(tieNote));
    w.appendChild(analyticsHBar(Math.min(100, pctSlots)));
    grid.appendChild(w);
  }

  const best = _rec(data.most_completed_team);
  if (best) {
    const allDone = _bool(best.all_teams_complete);
    const w = el("article", { class: "stat-widget stat-widget--team" });
    w.appendChild(el("div", { class: "stat-widget__eyebrow" }, "Closest to complete"));
    const row = el("div", { class: "stat-widget__row" });
    if (allDone) {
      row.appendChild(analyticsPctRing(100, "20/20"));
      const col = el("div", { class: "stat-widget__col" });
      col.appendChild(el("div", { class: "stat-widget__title" }, "All national teams"));
      col.appendChild(
        el(
          "p",
          { class: "stat-widget__hint" },
          "Every team page has all 20 stickers (at least one copy each).",
        ),
      );
      col.appendChild(analyticsHBar(100));
      row.appendChild(col);
    } else {
      const code = _str(best.code, "?");
      const pct = _num(best.pct_complete, 0);
      const have = _num(best.slots_with_copy, 0);
      const miss = _num(best.slots_missing, 0);
      const tieNote = _str(best.tie_note, "");
      const tied = _bool(best.tied);
      row.appendChild(analyticsPctRing(pct, `${have}/20`));
      const col = el("div", { class: "stat-widget__col" });
      col.appendChild(el("div", { class: "stat-widget__code" }, code));
      col.appendChild(
        el(
          "p",
          { class: "stat-widget__hint" },
          `${have} slot${have === 1 ? "" : "s"} with at least one copy · ${miss} still empty on this page`,
        ),
      );
      if (tied && tieNote) col.appendChild(formatTieNote(tieNote));
      col.appendChild(analyticsHBar(pct));
      row.appendChild(col);
    }
    w.appendChild(row);
    grid.appendChild(w);
  }

  const worst = _rec(data.most_missing_team);
  if (worst) {
    const code = _str(worst.code, "?");
    const miss = _num(worst.slots_missing, 0);
    const pct = _num(worst.pct_complete, 0);
    const tieNote = _str(worst.tie_note, "");
    const tied = _bool(worst.tied);
    const w = el("article", { class: "stat-widget stat-widget--hunt" });
    w.appendChild(el("div", { class: "stat-widget__eyebrow" }, "Hunt zone"));
    const row = el("div", { class: "stat-widget__row" });
    row.appendChild(analyticsPctRing(pct, `${20 - miss}/20`));
    const col = el("div", { class: "stat-widget__col" });
    col.appendChild(el("div", { class: "stat-widget__code" }, code));
    col.appendChild(
      el("p", { class: "stat-widget__hint" }, `${miss} sticker${miss === 1 ? "" : "s"} still missing here — trade priority?`),
    );
    if (tied && tieNote) col.appendChild(formatTieNote(tieNote));
    col.appendChild(analyticsHBar(pct));
    row.appendChild(col);
    w.appendChild(row);
    grid.appendChild(w);
  }

  const fwc = _rec(data.fwc_summary);
  if (fwc) {
    const name = _str(fwc.name, "FWC");
    const pct = _num(fwc.pct_complete, 0);
    const miss = _num(fwc.slots_missing, 0);
    const have = _num(fwc.slots_with_copy, 0);
    const total = _num(fwc.slots_total, 20);
    const w = el("article", { class: "stat-widget stat-widget--cup" });
    w.appendChild(el("div", { class: "stat-widget__eyebrow" }, "FWC & specials"));
    const row = el("div", { class: "stat-widget__row" });
    row.appendChild(analyticsPctRing(pct, `${have}/${total}`));
    const col = el("div", { class: "stat-widget__col" });
    col.appendChild(el("div", { class: "stat-widget__title" }, name));
    col.appendChild(el("p", { class: "stat-widget__hint" }, `${miss} missing in this sheet`));
    col.appendChild(analyticsHBar(pct));
    row.appendChild(col);
    w.appendChild(row);
    grid.appendChild(w);
  }

  const shieldPhoto = _rec(data.team_shield_photo);
  if (shieldPhoto) {
    const shield = _rec(shieldPhoto.shield);
    if (shield) {
      const pct = _num(shield.pct_complete, 0);
      const have = _num(shield.with_copy, 0);
      const total = _num(shield.total, 48);
      const miss = _num(shield.missing, 0);
      const w = el("article", { class: "stat-widget stat-widget--crest" });
      w.appendChild(el("div", { class: "stat-widget__eyebrow" }, "Team shields"));
      w.appendChild(
        el("p", { class: "stat-widget__hint", style: "margin:0 0 0.35rem" }, "Slot 1 on every team page (48 crest stickers)."),
      );
      const row = el("div", { class: "stat-widget__row" });
      row.appendChild(analyticsPctRing(pct, `${have}/${total}`));
      const col = el("div", { class: "stat-widget__col" });
      col.appendChild(el("div", { class: "stat-widget__title" }, `${have} of ${total} in the album`));
      col.appendChild(
        el(
          "p",
          { class: "stat-widget__hint" },
          miss === 0 ? "All shields accounted for." : `${miss} shield${miss === 1 ? "" : "s"} still missing.`,
        ),
      );
      col.appendChild(analyticsHBar(pct));
      row.appendChild(col);
      w.appendChild(row);
      grid.appendChild(w);
    }
    const photo = _rec(shieldPhoto.team_photo);
    if (photo) {
      const pct = _num(photo.pct_complete, 0);
      const have = _num(photo.with_copy, 0);
      const total = _num(photo.total, 48);
      const miss = _num(photo.missing, 0);
      const w = el("article", { class: "stat-widget stat-widget--jersey" });
      w.appendChild(el("div", { class: "stat-widget__eyebrow" }, "Team photos"));
      w.appendChild(
        el("p", { class: "stat-widget__hint", style: "margin:0 0 0.35rem" }, "Slot 13 on every team page (48 squad photos)."),
      );
      const row = el("div", { class: "stat-widget__row" });
      row.appendChild(analyticsPctRing(pct, `${have}/${total}`));
      const col = el("div", { class: "stat-widget__col" });
      col.appendChild(el("div", { class: "stat-widget__title" }, `${have} of ${total} in the album`));
      col.appendChild(
        el(
          "p",
          { class: "stat-widget__hint" },
          miss === 0 ? "All team photos accounted for." : `${miss} photo${miss === 1 ? "" : "s"} still missing.`,
        ),
      );
      col.appendChild(analyticsHBar(pct));
      row.appendChild(col);
      w.appendChild(row);
      grid.appendChild(w);
    }
  }

  const teamsFull = _rec(data.teams_fully_complete);
  if (teamsFull) {
    const n = _num(teamsFull.teams_fully_complete, 0);
    const total = _num(teamsFull.teams_total, 48);
    const pct = _num(teamsFull.pct_teams_fully_complete, 0);
    const rest = Math.max(0, total - n);
    const w = el("article", { class: "stat-widget stat-widget--squad" });
    w.appendChild(el("div", { class: "stat-widget__eyebrow" }, "Full team pages"));
    w.appendChild(
      el(
        "p",
        { class: "stat-widget__hint", style: "margin:0 0 0.35rem" },
        "National teams with all 20 stickers present (≥1 copy each).",
      ),
    );
    const row = el("div", { class: "stat-widget__row" });
    row.appendChild(analyticsPctRing(pct, `${n}/${total}`));
    const col = el("div", { class: "stat-widget__col" });
    col.appendChild(el("div", { class: "stat-widget__title" }, `${n} of ${total} complete`));
    col.appendChild(
      el(
        "p",
        { class: "stat-widget__hint" },
        rest === 0
          ? "Every team sheet is finished."
          : `${rest} team sheet${rest === 1 ? "" : "s"} still incomplete — open Team analytics.`,
      ),
    );
    col.appendChild(analyticsHBar(pct));
    row.appendChild(col);
    w.appendChild(row);
    grid.appendChild(w);
  }

  if (!grid.children.length) {
    grid.appendChild(
      el("p", { class: "stat-widget__empty", style: "margin:0;color:var(--muted)" }, "No analytics yet — add some stickers first."),
    );
  }

  return grid;
}

function flagCell(ok: boolean, title: string): HTMLElement {
  const span = el("span", { class: `team-flag ${ok ? "team-flag--ok" : "team-flag--miss"}` }, ok ? "✓" : "✗");
  span.title = title;
  return span;
}

function buildAnalytics(): HTMLElement {
  const section = el("section", { class: "view", id: "view-analytics" });
  views.analytics = section;
  section.appendChild(el("h2", {}, "Team analytics"));
  section.appendChild(
    el(
      "p",
      { class: "muted", style: "margin:0 0 1rem;font-size:0.95rem;max-width:52rem" },
      "Each row is one national team page (20 stickers). Shield is slot 1, team photo is slot 13. Flags show whether you have at least one copy. Click column headers to sort.",
    ),
  );
  const host = el("div", { id: "analytics-teams-host" });

  type TeamSortKey = "code" | "pct_complete" | "shield_ok" | "team_photo_ok";
  let cachedTeams: TeamAnalyticsRow[] = [];
  let catalogOrder = new Map<string, number>();
  let sortState: { key: TeamSortKey | null; dir: number } = { key: null, dir: 1 };

  function compareTeams(a: TeamAnalyticsRow, b: TeamAnalyticsRow): number {
    const d = sortState.dir;
    switch (sortState.key) {
      case "code":
        return (catalogOrder.get(a.code)! - catalogOrder.get(b.code)!) * d;
      case "pct_complete":
        if (a.pct_complete !== b.pct_complete) return (a.pct_complete - b.pct_complete) * d;
        return (catalogOrder.get(a.code)! - catalogOrder.get(b.code)!) * d;
      case "shield_ok": {
        const va = a.shield_ok ? 1 : 0;
        const vb = b.shield_ok ? 1 : 0;
        if (va !== vb) return (va - vb) * d;
        return (catalogOrder.get(a.code)! - catalogOrder.get(b.code)!) * d;
      }
      case "team_photo_ok": {
        const va = a.team_photo_ok ? 1 : 0;
        const vb = b.team_photo_ok ? 1 : 0;
        if (va !== vb) return (va - vb) * d;
        return (catalogOrder.get(a.code)! - catalogOrder.get(b.code)!) * d;
      }
      default:
        return 0;
    }
  }

  function sortedTeams(): TeamAnalyticsRow[] {
    if (sortState.key === null) return [...cachedTeams];
    return [...cachedTeams].sort(compareTeams);
  }

  function updateSortHeaderClasses(thead: HTMLElement): void {
    thead.querySelectorAll("th.th-sortable").forEach((cell) => {
      const th = cell as HTMLTableCellElement;
      th.classList.remove("th-sorted", "th-sorted-asc", "th-sorted-desc");
      const k = th.dataset.sort as TeamSortKey | undefined;
      if (k && sortState.key === k) {
        th.classList.add("th-sorted", sortState.dir === 1 ? "th-sorted-asc" : "th-sorted-desc");
      }
    });
  }

  function buildTeamRow(t: TeamAnalyticsRow): HTMLTableRowElement {
    const tr = el("tr", {});
    tr.appendChild(el("td", { class: "ref" }, t.code));
    const pct = Math.min(100, Math.max(0, t.pct_complete));
    const pctCell = el("td", { class: "team-pct-cell" });
    const track = el("div", { class: "team-pct-track" });
    const fill = el("div", { class: "team-pct-fill" });
    fill.style.width = `${pct}%`;
    track.appendChild(fill);
    const label = el("div", { class: "team-pct-label" });
    label.appendChild(el("span", { class: "team-pct-val" }, `${t.pct_complete}%`));
    label.appendChild(document.createTextNode(" "));
    label.appendChild(
      el("span", { class: "muted team-pct-fraction" }, `(${t.slots_with_copy}/${t.slots_total})`),
    );
    track.appendChild(label);
    pctCell.appendChild(track);
    tr.appendChild(pctCell);
    tr.appendChild(
      el(
        "td",
        { class: "team-flag-cell" },
        flagCell(t.shield_ok, t.shield_ok ? "Shield in album" : "Shield missing"),
      ),
    );
    tr.appendChild(
      el(
        "td",
        { class: "team-flag-cell" },
        flagCell(t.team_photo_ok, t.team_photo_ok ? "Team photo in album" : "Team photo missing"),
      ),
    );
    return tr;
  }

  function renderTeamTableBody(tbody: HTMLElement, thead: HTMLElement): void {
    tbody.replaceChildren();
    for (const t of sortedTeams()) {
      tbody.appendChild(buildTeamRow(t));
    }
    updateSortHeaderClasses(thead);
  }

  function wireSortableHeaders(thead: HTMLElement, tbody: HTMLElement): void {
    thead.querySelectorAll("th.th-sortable").forEach((cell) => {
      const th = cell as HTMLTableCellElement;
      th.addEventListener("click", () => {
        const k = th.dataset.sort as TeamSortKey;
        if (sortState.key === k) sortState.dir *= -1;
        else {
          sortState.key = k;
          sortState.dir = 1;
        }
        renderTeamTableBody(tbody, thead);
      });
    });
  }

  async function loadTeams(): Promise<void> {
    host.innerHTML = "";
    host.appendChild(el("p", { class: "muted" }, "Loading…"));
    try {
      const { teams } = await getAnalyticsTeams();
      cachedTeams = teams;
      catalogOrder = new Map(teams.map((t, i) => [t.code, i]));
      sortState = { key: null, dir: 1 };
      host.innerHTML = "";
      const wrap = el("div", { class: "analytics-table-wrap" });
      const tbl = el("table", { class: "data analytics-teams-table" });
      const thead = el(
        "thead",
        {},
        el(
          "tr",
          {},
          el("th", { class: "th-sortable", "data-sort": "code", title: "Album order · click to sort" }, "Team"),
          el("th", { class: "th-sortable", "data-sort": "pct_complete", title: "Click to sort by completion %" }, "% complete"),
          el("th", {
            class: "th-sortable",
            "data-sort": "shield_ok",
            title: "Slot 1 — shield / crest · click to sort",
          }, "Shield"),
          el("th", {
            class: "th-sortable",
            "data-sort": "team_photo_ok",
            title: "Slot 13 — squad photo · click to sort",
          }, "Photo"),
        ),
      );
      const tbody = el("tbody");
      renderTeamTableBody(tbody, thead);
      wireSortableHeaders(thead, tbody);
      tbl.append(thead, tbody);
      wrap.appendChild(tbl);
      host.appendChild(wrap);
    } catch (e) {
      host.innerHTML = "";
      host.appendChild(errBox(e));
    }
  }

  analyticsPage.reload = loadTeams;
  section.appendChild(host);
  return section;
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

  const sessionMsg = el("div", { class: "msg-ok" });
  const sessionErr = el("div", { class: "msg-error" });

  const lastSession = { packs: 0, out: 0, inn: 0 };
  let sessionEditing = false;

  const sessionInputs = {
    packs: el("input", { type: "number", min: "0" }) as HTMLInputElement,
    out: el("input", { type: "number", min: "0" }) as HTMLInputElement,
    inn: el("input", { type: "number", min: "0" }) as HTMLInputElement,
  };

  const sessionReadVals = {
    packs: el("span", { class: "session-info-val" }),
    out: el("span", { class: "session-info-val" }),
    inn: el("span", { class: "session-info-val" }),
  };

  const sessionReadHost = el("div", { class: "session-readonly" });
  function sessionAddReadRow(label: string, valEl: HTMLElement): void {
    const row = el("div", { class: "session-info-row" });
    row.appendChild(el("span", { class: "session-info-label" }, label));
    row.appendChild(valEl);
    sessionReadHost.appendChild(row);
  }
  sessionAddReadRow("Packs opened", sessionReadVals.packs);
  sessionAddReadRow("Traded out", sessionReadVals.out);
  sessionAddReadRow("Traded in", sessionReadVals.inn);

  const sessionEditHost = el("div", { class: "session-edit-host" });
  sessionEditHost.style.display = "none";
  const sg = el("div", { class: "session-grid" });
  sg.appendChild(el("div", {}, el("label", { class: "field" }, "Packs opened"), sessionInputs.packs));
  sg.appendChild(el("div", {}, el("label", { class: "field" }, "Traded out"), sessionInputs.out));
  sg.appendChild(el("div", {}, el("label", { class: "field" }, "Traded in"), sessionInputs.inn));
  sessionEditHost.appendChild(sg);
  const editActions = el("div", { class: "session-edit-actions" });
  const saveSession = el("button", { class: "btn btn-primary", type: "button" }, "Save");
  const cancelSession = el("button", { class: "btn", type: "button" }, "Cancel");
  editActions.append(saveSession, cancelSession);
  sessionEditHost.appendChild(editActions);

  const sessionHead = el("div", { class: "session-head" });
  sessionHead.appendChild(el("h3", {}, "Session counters"));
  const editSessionBtn = el("button", { class: "btn", type: "button" }, "Edit");
  sessionHead.appendChild(editSessionBtn);

  function applySessionToUI(): void {
    sessionReadVals.packs.textContent = String(lastSession.packs);
    sessionReadVals.out.textContent = String(lastSession.out);
    sessionReadVals.inn.textContent = String(lastSession.inn);
    sessionInputs.packs.value = String(lastSession.packs);
    sessionInputs.out.value = String(lastSession.out);
    sessionInputs.inn.value = String(lastSession.inn);
  }

  function leaveSessionEdit(): void {
    sessionEditing = false;
    sessionReadHost.style.display = "grid";
    sessionEditHost.style.display = "none";
    editSessionBtn.style.display = "";
  }

  function enterSessionEdit(): void {
    sessionEditing = true;
    applySessionToUI();
    sessionReadHost.style.display = "none";
    sessionEditHost.style.display = "block";
    editSessionBtn.style.display = "none";
    sessionMsg.textContent = "";
    sessionErr.textContent = "";
    sessionInputs.packs.focus();
  }

  editSessionBtn.addEventListener("click", () => enterSessionEdit());
  cancelSession.addEventListener("click", () => {
    applySessionToUI();
    leaveSessionEdit();
  });
  saveSession.addEventListener("click", async () => {
    sessionMsg.textContent = "";
    sessionErr.textContent = "";
    try {
      await patchSession({
        packs_opened: parseInt(sessionInputs.packs.value, 10) || 0,
        traded_out_count: parseInt(sessionInputs.out.value, 10) || 0,
        traded_in_count: parseInt(sessionInputs.inn.value, 10) || 0,
      });
      lastSession.packs = parseInt(sessionInputs.packs.value, 10) || 0;
      lastSession.out = parseInt(sessionInputs.out.value, 10) || 0;
      lastSession.inn = parseInt(sessionInputs.inn.value, 10) || 0;
      applySessionToUI();
      leaveSessionEdit();
      sessionMsg.textContent = "Saved.";
    } catch (e) {
      sessionErr.replaceChildren(errBox(e));
    }
  });

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

      lastSession.packs = m.session.packs_opened;
      lastSession.out = m.session.traded_out_count;
      lastSession.inn = m.session.traded_in_count;
      applySessionToUI();
      if (sessionEditing) leaveSessionEdit();
    } catch (e) {
      metricsHost.innerHTML = "";
      metricsHost.appendChild(errBox(e));
      analyticsHost.innerHTML = "";
      return;
    }

    try {
      const an = await getAnalytics();
      analyticsHost.innerHTML = "";
      analyticsHost.appendChild(el("h3", {}, "Analytics"));
      analyticsHost.appendChild(renderAnalyticsWidgets(an));
      const foot = el("p", { class: "analytics-card-foot" });
      const link = el("a", { href: "#", class: "analytics-full-link" }, "Full team analytics →");
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        showView("analytics");
      });
      foot.appendChild(link);
      analyticsHost.appendChild(foot);
    } catch (e) {
      analyticsHost.innerHTML = "";
      analyticsHost.appendChild(el("h3", {}, "Analytics"));
      analyticsHost.appendChild(errBox(e));
    }
  }

  sessionHost.appendChild(sessionHead);
  sessionHost.appendChild(
    el("p", { class: "muted", style: "margin:0 0 0.75rem;font-size:0.9rem" }, "Pack opens and trades update these automatically. Use Edit to correct them if your notes drift."),
  );
  sessionHost.appendChild(sessionReadHost);
  sessionHost.appendChild(sessionEditHost);
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

function lookupStatusBadgeClass(status: string): string {
  if (status === "missing") return "lookup-badge lookup-badge--missing";
  if (status === "duplicate") return "lookup-badge lookup-badge--dup";
  return "lookup-badge lookup-badge--ok";
}

function formatLookupStatusLabel(status: string): string {
  if (status === "missing") return "Missing";
  if (status === "duplicate") return "Duplicates";
  return "In album";
}

function renderLookupResult(r: StickerDetail): HTMLElement {
  const host = el("div", { class: "lookup-result" });
  const displayRef = albumStickerRefLabel(r);
  host.appendChild(el("div", { class: "lookup-result-ref ref" }, displayRef));

  const pageRow = el("div", { class: "lookup-page-row" });
  const printedPage = r.album_printed_page;
  if (typeof printedPage === "number" && printedPage >= 0) {
    pageRow.appendChild(el("div", { class: "lookup-page-pill" }, `Printed page ${printedPage}`));
  }
  const grp = r.album_index_group;
  if (typeof grp === "string" && grp.length > 0) {
    pageRow.appendChild(el("div", { class: "lookup-group-pill" }, `Group ${grp}`));
  }
  if (pageRow.childNodes.length > 0) {
    host.appendChild(pageRow);
  }

  const top = el("div", { class: "lookup-result-top" });
  top.appendChild(el("span", { class: lookupStatusBadgeClass(r.status) }, formatLookupStatusLabel(r.status)));
  top.appendChild(
    el(
      "span",
      { class: "lookup-result-counts" },
      `${r.qty} in your stack | ${r.spare_copies} spare${r.spare_copies === 1 ? "" : "s"}`,
    ),
  );
  if (r.category_code !== "FWC" && typeof r.album_team_ordinal === "number") {
    top.appendChild(
      el("span", { class: "lookup-team-ord" }, `Album team order #${r.album_team_ordinal} of 48`),
    );
  }
  host.appendChild(top);

  host.appendChild(el("p", { class: "lookup-result-role" }, listStickerRoleTitle(r.role)));

  const loc = typeof r.album_location === "string" && r.album_location.trim() ? r.album_location.trim() : "";
  if (loc) {
    host.appendChild(el("p", { class: "lookup-result-loc" }, loc));
  }

  const rawPaste = typeof r.album_paste_line === "string" ? r.album_paste_line.trim() : "";
  const paste =
    rawPaste ||
    (r.category_code === "FWC" && r.album_code ? `FWC ${r.album_code}` : `${r.category_code} ${r.slot_code}`);
  if (paste) {
    const pasteCard = el("div", { class: "lookup-paste-card" });
    pasteCard.appendChild(el("div", { class: "lookup-paste-label" }, "Album / paste line"));
    pasteCard.appendChild(el("div", { class: "lookup-paste-line ref" }, paste));
    const btnRow = el("div", { class: "lookup-paste-actions" });
    const copyAlbum = el("button", { class: "btn btn-primary", type: "button" }, "Copy album line");
    copyAlbum.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(paste);
        copyAlbum.textContent = "Copied!";
        setTimeout(() => {
          copyAlbum.textContent = "Copy album line";
        }, 1600);
      } catch {
        copyAlbum.textContent = "Copy failed";
      }
    });
    const copyRef = el("button", { class: "btn", type: "button" }, "Copy app ref");
    copyRef.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(r.ref);
        copyRef.textContent = "Copied!";
        setTimeout(() => {
          copyRef.textContent = "Copy app ref";
        }, 1600);
      } catch {
        copyRef.textContent = "Copy failed";
      }
    });
    btnRow.append(copyAlbum, copyRef);
    pasteCard.appendChild(btnRow);
    host.appendChild(pasteCard);
  }

  if (displayRef !== r.ref) {
    host.appendChild(el("p", { class: "lookup-result-meta" }, `App ref: ${r.ref}`));
  }

  return host;
}

function buildLists(): HTMLElement {
  const section = el("section", { class: "view", id: "view-lists" });
  views.lists = section;
  section.appendChild(el("h2", {}, "Lists"));

  const LISTS_INTRO =
    "Grouped by team page (FWC first). Ref text is colored by sticker type. Tap a row to open Desk → Lookup with that sticker. ";

  const lead = el("p", { class: "lists-lead" });
  lead.textContent = `${LISTS_INTRO}Use Reload to refresh counts.`;
  section.appendChild(lead);

  const toolbar = el("div", { class: "lists-toolbar" });
  const loadBtn = el("button", { class: "btn btn-primary", type: "button" }, "Reload");
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
  const printLink = el(
    "a",
    { href: listsPrintUrl(), target: "_blank", rel: "noopener", class: "lists-print-link" },
    "Printable sheet",
  );
  toolbar.append(loadBtn, copyMiss, copyDup, printLink);
  section.appendChild(toolbar);

  const tabs = el("div", { class: "lists-tabs", role: "tablist" });
  const tabMissBtn = el("button", { class: "btn lists-tab is-active", type: "button", role: "tab" }, "Missing (0)");
  const tabDupBtn = el("button", { class: "btn lists-tab", type: "button", role: "tab" }, "Duplicates (0)");
  tabs.append(tabMissBtn, tabDupBtn);
  section.appendChild(tabs);

  const listsBulkRow = el("div", { class: "lists-bulk-row" });
  const expandAllBtn = el("button", { class: "btn lists-bulk-btn", type: "button", title: "Open every team group (Missing + Duplicates)" }, "Expand all");
  const collapseAllBtn = el("button", { class: "btn lists-bulk-btn", type: "button", title: "Close every team group (Missing + Duplicates)" }, "Collapse all");
  function setAllListGroups(open: boolean): void {
    for (const host of [missPanel, dupPanel]) {
      host.querySelectorAll("details.lists-group").forEach((node) => {
        (node as HTMLDetailsElement).open = open;
      });
    }
  }
  expandAllBtn.addEventListener("click", () => setAllListGroups(true));
  collapseAllBtn.addEventListener("click", () => setAllListGroups(false));
  listsBulkRow.append(expandAllBtn, collapseAllBtn);
  section.appendChild(listsBulkRow);

  const legend = el("div", { class: "lists-legend", "aria-label": "Sticker type colors" });
  legend.appendChild(el("span", { class: "lists-legend-title" }, "Ref colors"));
  const legendPairs: [string, string][] = [
    ["lists-line-ref--shield", "Shield"],
    ["lists-line-ref--photo", "Team photo"],
    ["lists-line-ref--fwc-sp", "FWC 00"],
    ["lists-line-ref--fwc", "FWC"],
    ["lists-line-ref--player", "Player"],
  ];
  for (const [cls, label] of legendPairs) {
    legend.appendChild(document.createTextNode(" · "));
    legend.appendChild(el("span", { class: `lists-legend-chip ${cls}` }, label));
  }
  section.appendChild(legend);

  const missPanel = el("div", { class: "lists-panel card" });
  const dupPanel = el("div", { class: "lists-panel card", hidden: true });

  let activeTab: "missing" | "dup" = "missing";
  function applyTab(which: "missing" | "dup"): void {
    activeTab = which;
    tabMissBtn.classList.toggle("is-active", which === "missing");
    tabDupBtn.classList.toggle("is-active", which === "dup");
    missPanel.toggleAttribute("hidden", which !== "missing");
    dupPanel.toggleAttribute("hidden", which !== "dup");
  }
  tabMissBtn.addEventListener("click", () => applyTab("missing"));
  tabDupBtn.addEventListener("click", () => applyTab("dup"));

  let missingRows: ListStickerRow[] = [];
  let dupRows: ListStickerRow[] = [];

  function dupSpare(row: ListStickerRow): number {
    return row.spare_copies ?? Math.max(0, row.qty - 1);
  }

  function makeListsLineButton(row: ListStickerRow, extras: number | null): HTMLElement {
    const refShown = listStickerDisplayRef(row);
    const btn = el("button", { type: "button", class: "lists-line" });
    const hint = _str(row.album_hover_hint, "");
    btn.title = hint
      ? `${hint} | Click: open in Desk`
      : `${listStickerRoleTitle(row.role)} — open "${refShown}" in Desk`;
    const refEl = el("span", { class: listStickerRoleRefClass(row.role) }, refShown);
    btn.appendChild(refEl);
    if (extras != null) {
      btn.appendChild(el("span", { class: "lists-line-extras" }, `+${extras}`));
    }
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      const fn = openDeskLookupFromLists;
      if (fn) void fn(refShown);
    });
    return btn;
  }

  function renderMissing(): void {
    missPanel.innerHTML = "";
    if (missingRows.length === 0) {
      missPanel.appendChild(
        el("p", { class: "lists-empty" }, "Nothing missing — you have at least one copy of every sticker in the album."),
      );
      return;
    }
    const host = el("div", { class: "lists-groups" });
    for (const { code, rows } of groupListRowsByCategory(missingRows)) {
      const det = el("details", { class: "lists-group", open: true });
      const summary = el("summary", { class: "lists-group-summary" });
      summary.appendChild(el("span", { class: "lists-group-code" }, code));
      summary.appendChild(
        el(
          "span",
          { class: "lists-group-meta" },
          `${rows.length} missing`,
        ),
      );
      det.appendChild(summary);
      const body = el("div", { class: "lists-group-body" });
      for (const r of rows) {
        body.appendChild(makeListsLineButton(r, null));
      }
      det.appendChild(body);
      host.appendChild(det);
    }
    missPanel.appendChild(host);
  }

  function renderDup(): void {
    dupPanel.innerHTML = "";
    if (dupRows.length === 0) {
      dupPanel.appendChild(
        el(
          "p",
          { class: "lists-empty" },
          "No stacks with extras — every sticker you hold is a single copy (or zero).",
        ),
      );
      return;
    }
    const host = el("div", { class: "lists-groups" });
    for (const { code, rows } of groupListRowsByCategory(dupRows)) {
      const spareTotal = rows.reduce((s, r) => s + dupSpare(r), 0);
      const det = el("details", { class: "lists-group", open: true });
      const summary = el("summary", { class: "lists-group-summary" });
      summary.appendChild(el("span", { class: "lists-group-code" }, code));
      summary.appendChild(
        el(
          "span",
          { class: "lists-group-meta" },
          `${rows.length} slot${rows.length === 1 ? "" : "s"} with extras · +${spareTotal} spare copies`,
        ),
      );
      det.appendChild(summary);
      const body = el("div", { class: "lists-group-body" });
      for (const r of rows) {
        body.appendChild(makeListsLineButton(r, dupSpare(r)));
      }
      det.appendChild(body);
      host.appendChild(det);
    }
    dupPanel.appendChild(host);
  }

  function updateTabLabels(): void {
    tabMissBtn.textContent = `Missing (${missingRows.length})`;
    tabDupBtn.textContent = `Duplicates (${dupRows.length})`;
  }

  async function load(): Promise<void> {
    missPanel.innerHTML = "";
    dupPanel.innerHTML = "";
    missPanel.appendChild(el("p", { class: "lists-empty" }, "Loading…"));
    dupPanel.appendChild(el("p", { class: "lists-empty" }, "Loading…"));
    dupPanel.toggleAttribute("hidden", activeTab !== "dup");
    missPanel.toggleAttribute("hidden", activeTab !== "missing");
    try {
      missingRows = await getMissingList();
      dupRows = await getDuplicatesList();
      updateTabLabels();
      const n = missingRows.length;
      const d = dupRows.length;
      lead.textContent =
        LISTS_INTRO +
        (n === 0 && d === 0
          ? "Nothing missing and no duplicate stacks."
          : `${n} sticker${n === 1 ? "" : "s"} still missing · ${d} slot${d === 1 ? "" : "s"} with extras to trade.`);
      renderMissing();
      renderDup();
    } catch (e) {
      missPanel.innerHTML = "";
      dupPanel.innerHTML = "";
      missPanel.appendChild(errBox(e));
      dupPanel.appendChild(el("p", { class: "lists-empty" }, "—"));
      lead.textContent = LISTS_INTRO + "Could not load lists.";
    }
  }

  loadBtn.addEventListener("click", () => load());
  section.append(missPanel, dupPanel);
  load();
  return section;
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
  const lookupResultHost = el("div", { class: "lookup-result-host" });
  const lookupErr = el("div", { class: "lookup-errors" });
  lookupCard.appendChild(el("h3", {}, "Lookup"));
  lookupCard.appendChild(el("label", { class: "field" }, "Sticker ref"));
  lookupCard.appendChild(refInput);
  const lookupBtn = el("button", { class: "btn btn-primary", type: "button" }, "Look up");
  async function runLookup(): Promise<void> {
    lookupResultHost.replaceChildren();
    lookupErr.replaceChildren();
    try {
      const expanded = expandRefsFromLine(refInput.value.trim());
      if (expanded.length === 0) {
        lookupErr.appendChild(el("div", { class: "msg-error" }, "Enter a sticker ref."));
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
      lookupResultHost.appendChild(renderLookupResult(r));
    } catch (e) {
      lookupErr.replaceChildren(errBox(e));
    }
  }
  lookupBtn.addEventListener("click", () => void runLookup());
  lookupCard.appendChild(lookupBtn);
  lookupCard.appendChild(lookupErr);
  lookupCard.appendChild(lookupResultHost);

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

  openDeskLookupFromLists = async (ref: string) => {
    refInput.value = ref.trim();
    showView("desk");
    refInput.focus();
    lookupCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    await runLookup();
  };

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

  let pendingUndo: { give: string[]; take: string[] } | null = null;
  const tradeResultCard = el("div", { class: "card trade-result-card" });
  tradeResultCard.style.display = "none";

  function clearTradeOutcome(): void {
    pendingUndo = null;
    tradeResultCard.style.display = "none";
    tradeResultCard.replaceChildren();
  }

  function renderRefChips(items: { ref: string; qty_before: number; qty_after: number }[]): HTMLElement {
    const wrap = el("div", { class: "trade-result-chips" });
    if (items.length === 0) {
      wrap.appendChild(el("span", { class: "trade-result-empty" }, "—"));
      return wrap;
    }
    for (const it of items) {
      wrap.appendChild(
        el(
          "div",
          { class: "trade-ref-chip" },
          el("span", { class: "trade-ref-chip__ref ref" }, it.ref),
          el("span", { class: "trade-ref-chip__qty" }, `${it.qty_before} → ${it.qty_after}`),
        ),
      );
    }
    return wrap;
  }

  function renderUndoOutcome(ur: TradeResponse): void {
    tradeResultCard.style.display = "block";
    tradeResultCard.replaceChildren();
    tradeResultCard.appendChild(el("h3", {}, "Trade undone"));
    const grid = el("div", { class: "trade-result-grid" });
    const colRm = el("div", { class: "trade-result-col trade-result-col--out" });
    colRm.appendChild(el("div", { class: "trade-result-col-title" }, "Returned / removed"));
    colRm.appendChild(renderRefChips(ur.gave));
    const colOk = el("div", { class: "trade-result-col trade-result-col--in" });
    colOk.appendChild(el("div", { class: "trade-result-col-title" }, "Restored to your album"));
    colOk.appendChild(renderRefChips(ur.received));
    grid.append(colRm, colOk);
    tradeResultCard.appendChild(grid);
  }

  function renderTradeOutcome(r: TradeResponse, forwardGive: string[], forwardTake: string[]): void {
    pendingUndo = { give: [...forwardGive], take: [...forwardTake] };
    tradeResultCard.style.display = "block";
    tradeResultCard.replaceChildren();
    tradeResultCard.appendChild(el("h3", {}, "Trade recorded"));
    tradeResultCard.appendChild(
      el(
        "p",
        { class: "trade-result-lede muted" },
        "Text boxes cleared. Undo puts inventory and session trade counters back the way they were, until you change these lists again.",
      ),
    );

    const grid = el("div", { class: "trade-result-grid" });
    const colOut = el("div", { class: "trade-result-col trade-result-col--out" });
    colOut.appendChild(el("div", { class: "trade-result-col-title" }, "Out of your album"));
    colOut.appendChild(renderRefChips(r.gave));
    const colIn = el("div", { class: "trade-result-col trade-result-col--in" });
    colIn.appendChild(el("div", { class: "trade-result-col-title" }, "Into your album"));
    colIn.appendChild(renderRefChips(r.received));
    grid.append(colOut, colIn);
    tradeResultCard.appendChild(grid);

    if (r.warnings.length > 0) {
      const wbox = el("div", { class: "banner-info trade-result-warn" });
      wbox.appendChild(el("strong", {}, "Notes — "));
      wbox.appendChild(document.createTextNode(r.warnings.join(" · ")));
      tradeResultCard.appendChild(wbox);
    }

    const undoRow = el("div", { class: "trade-result-actions" });
    const undoBtn = el("button", { class: "btn", type: "button" }, "Undo this trade");
    undoBtn.addEventListener("click", async () => {
      if (!pendingUndo) return;
      undoBtn.disabled = true;
      try {
        const ur = await undoTrade(pendingUndo.give, pendingUndo.take);
        pendingUndo = null;
        renderUndoOutcome(ur);
        await loadTradePreviewData();
        updateTradePreview();
      } catch (e) {
        undoBtn.disabled = false;
        tradeResultCard.appendChild(errBox(e));
      }
    });
    undoRow.appendChild(undoBtn);
    tradeResultCard.appendChild(undoRow);
  }

  function onGiveTakeInput(): void {
    if (pendingUndo) clearTradeOutcome();
    updateTradePreview();
  }

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
  giveTa.addEventListener("input", onGiveTakeInput);
  takeTa.addEventListener("input", onGiveTakeInput);

  const submit = el("button", { class: "btn btn-primary", type: "button" }, "Execute trade");

  submit.addEventListener("click", async () => {
    clearTradeOutcome();
    try {
      const give = parseRefLines(giveTa.value);
      const take = parseRefLines(takeTa.value);
      const r = await executeTrade(give, take, strictCb.checked, unevenCb.checked);
      giveTa.value = "";
      takeTa.value = "";
      renderTradeOutcome(r, give, take);
      await loadTradePreviewData();
      updateTradePreview();
    } catch (e) {
      tradeResultCard.style.display = "block";
      tradeResultCard.replaceChildren(errBox(e));
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
  section.appendChild(tradeResultCard);

  const dupCard = el("div", { class: "card" });
  dupCard.appendChild(el("h3", {}, "Duplicates (click row to add to Give)"));
  const dupPicker = el("div", { id: "trade-dup-picker", class: "compact-list" });
  dupCard.appendChild(dupPicker);
  section.appendChild(dupCard);

  updateTradePreview();

  return section;
}
