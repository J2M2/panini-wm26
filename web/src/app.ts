import {
  ApiError,
  addSticker,
  checkPack,
  executeTrade,
  getAlbumTable,
  getAnalytics,
  getAnalyticsTeams,
  getAuthMe,
  getDuplicatesCompact,
  getDuplicatesList,
  getMetrics,
  getMissingCompact,
  getMissingList,
  getPackOutlook,
  getStickerByRef,
  getSnapshot,
  importSnapshot,
  listsPrintUrl,
  loginUser,
  logoutUser,
  openPack,
  patchSession,
  registerUser,
  removeSticker,
  resetAlbum,
  undoPackOpen,
  undoTrade,
} from "./api";
import { getLocale, setLocale, tr, trApiNote, trf, trTieNote } from "./i18n";
import { STICKERS_PER_PACK } from "./constants";
import {
  canonicalRef,
  expandRefsFromLine,
  parseBatchStickerLines,
  parseRefLines,
  splitInputLines,
  stickerPathFromRef,
  totalBatchCount,
} from "./parseRefs";
import { attachStickerRefAutocomplete } from "./refAutocomplete";
import {
  type AlbumOrderHint,
  compareRefsAlphabetically,
  compareRefsByAlbumOrder,
  sortRefsByAlbumOrder,
  sortTeamCodes,
} from "./albumOrder";
import { copyTextToClipboard, wrapFieldWithCopyButton } from "./copyField";
import type {
  InventoryMetrics,
  ListStickerRow,
  PackOutlookResponse,
  PackCheckResponse,
  PackCheckRow,
  StickerDetail,
  StickerRole,
  TeamAnalyticsRow,
  TradeResponse,
} from "./types";

/** Album-facing ref label for UI (FWC slot 20 / album 00 → `00` only; other FWC → `FWC:n`). */
function albumStickerRefLabel(row: {
  category_code: string;
  album_code?: string;
  ref: string;
  role?: StickerRole | null;
}): string {
  if (row.category_code === "FWC" && row.role === "fwc_special") {
    return row.album_code != null && row.album_code !== "" ? row.album_code : "00";
  }
  if (row.category_code === "FWC" && row.album_code != null && row.album_code !== "") {
    return `FWC:${row.album_code}`;
  }
  return row.ref;
}

/** Open Desk → Lookup with `ref` (album-style FWC ok). Set in `buildDesk`. */
let openDeskLookupFromLists: ((ref: string) => Promise<void>) | null = null;

/** Short sticker kind: Shield, Player, Team picture, or Special (all FWC / album block). */
function stickerTypeShortLabel(categoryCode: string, role: StickerRole | null | undefined): string {
  const cat = categoryCode.toUpperCase();
  if (cat === "FWC") {
    return "Special";
  }
  if (role === "shield") return "Shield";
  if (role === "team_photo") return "Team picture";
  return "Player";
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

/** Last sidebar route; used to clear sticker drafts when switching views. */
let lastNavRoute: string | null = null;

const PANINI_CLEAR_STICKER_DRAFTS = "panini-clear-sticker-drafts";

function clearStickerDraftsForView(route: string): void {
  const section = views[route];
  if (!section?.isConnected) return;
  section.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>("[data-sticker-draft]").forEach((field) => {
    field.value = "";
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  section.dispatchEvent(new CustomEvent(PANINI_CLEAR_STICKER_DRAFTS));
}

/** Canonical missing refs (qty === 0). */
let tradeMissingRefs: Set<string> | null = null;
/** Album index hints for missing refs (used in trade outcome summary). */
type TradeAlbumHint = {
  category_code: string;
  album_printed_page?: number;
  album_index_group?: string | null;
};
let tradeMissingHints: Map<string, TradeAlbumHint> | null = null;
/** Canonical ref → qty/spares for stickers with qty > 1. */
let tradeDupMap: Map<string, { qty: number; spare: number }> | null = null;
/** Set when missing/duplicate list fetch fails — preview cannot run until fixed. */
let tradePreviewLoadError: string | null = null;

let tradeDupRows: ListStickerRow[] = [];
type TradeDupSortMode = "spares" | "album";
let tradeDupSortMode: TradeDupSortMode = "spares";
let tradeDupExpanded = false;

/** Full team analytics view: refetch when navigating to Analytics. */
const analyticsPage = {
  reload: async (): Promise<void> => {},
};

/** Match helpers: refetch missing/dup sets when opening the Crosscheck view. */
const crosscheckPage = {
  reload: async (): Promise<void> => {},
};

/** Pack outlook simulation: refetch when opening that view. */
const packOutlookPage = {
  reload: async (): Promise<void> => {},
};

/** Overview metrics + analytics cards; refetch after auth / reset / import. */
const overviewPage = {
  reload: async (): Promise<void> => {},
};

async function loadTradePreviewData(): Promise<void> {
  tradePreviewLoadError = null;
  try {
    const [missing, dups] = await Promise.all([getMissingList(), getDuplicatesList()]);
    tradeMissingRefs = new Set(missing.map((r) => canonicalRef(r.ref)));
    tradeMissingHints = new Map(
      missing.map((r) => {
        const c = canonicalRef(r.ref);
        return [
          c,
          {
            category_code: r.category_code,
            album_printed_page: r.album_printed_page,
            album_index_group: r.album_index_group,
          },
        ];
      }),
    );
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
    tradeMissingHints = null;
    tradeDupMap = null;
    tradeDupRows = [];
    tradePreviewLoadError = e instanceof Error ? e.message : String(e);
    const box = document.getElementById("trade-dup-picker");
    if (box) box.textContent = tr("Could not load lists.");
    document.getElementById("trade-give")?.dispatchEvent(new Event("input"));
  }
}

function dupRowAlbumHint(r: ListStickerRow): AlbumOrderHint {
  return {
    category_code: r.category_code,
    slot_code: r.slot_code,
    album_printed_page: r.album_printed_page,
  };
}

function sortedTradeDupRows(rows: ListStickerRow[], mode: TradeDupSortMode): ListStickerRow[] {
  const copy = [...rows];
  const hints = new Map(copy.map((r) => [canonicalRef(r.ref), dupRowAlbumHint(r)]));
  if (mode === "spares") {
    copy.sort((a, b) => {
      const sa = a.spare_copies ?? Math.max(0, a.qty - 1);
      const sb = b.spare_copies ?? Math.max(0, b.qty - 1);
      if (sb !== sa) return sb - sa;
      return compareRefsByAlbumOrder(a.ref, b.ref, hints);
    });
  } else {
    copy.sort((a, b) => compareRefsByAlbumOrder(a.ref, b.ref, hints));
  }
  return copy;
}

function syncTradeDupPickerChrome(): void {
  document.querySelectorAll<HTMLButtonElement>(".trade-dup-sort-btn").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.sort === tradeDupSortMode);
  });
  const picker = document.getElementById("trade-dup-picker");
  picker?.classList.toggle("trade-dup-picker--expanded", tradeDupExpanded);
  const expandBtn = document.getElementById("trade-dup-expand");
  if (expandBtn) {
    expandBtn.textContent = tradeDupExpanded ? tr("Compact list") : tr("Expand list");
  }
  const countEl = document.getElementById("trade-dup-count");
  if (countEl) {
    countEl.textContent = trf("{n} with spares", { n: String(tradeDupRows.length) });
  }
}

function renderTradeDupPicker(): void {
  const box = document.getElementById("trade-dup-picker");
  if (!box) return;
  try {
    box.innerHTML = "";
    if (tradeDupRows.length === 0) {
      box.appendChild(el("p", { class: "muted", style: "margin:0;font-size:0.88rem" }, tr("No duplicates yet.")));
      syncTradeDupPickerChrome();
      return;
    }
    const sorted = sortedTradeDupRows(tradeDupRows, tradeDupSortMode);
    const showPage = tradeDupSortMode === "album";
    const tbl = el("table", { class: "data trade-dup-table" });
    const headCells = [tr("ref"), tr("spares")];
    if (showPage) headCells.push(tr("Page"));
    const thead = el("thead", {}, el("tr", {}, ...headCells.map((label) => el("th", {}, label))));
    const tbody = el("tbody");
    for (const r of sorted) {
      const row = el("tr", { class: "trade-dup-row" });
      row.appendChild(el("td", { class: "ref" }, r.ref));
      row.appendChild(el("td", {}, String(r.spare_copies ?? r.qty - 1)));
      if (showPage) {
        const page =
          typeof r.album_printed_page === "number" && r.album_printed_page >= 0
            ? String(r.album_printed_page)
            : "—";
        row.appendChild(el("td", { class: "muted" }, page));
      }
      row.title = tr("Click to append to Give");
      row.addEventListener("click", () => {
        const ta = document.getElementById("trade-give") as HTMLTextAreaElement | null;
        if (!ta) return;
        const lines = parseRefLines(ta.value);
        lines.push(r.ref);
        ta.value = `${lines.join("\n")}\n`;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
      });
      tbody.appendChild(row);
    }
    tbl.append(thead, tbody);
    box.appendChild(tbl);
    syncTradeDupPickerChrome();
  } catch {
    box.textContent = tr("Could not render duplicates.");
  }
}

/** Same rule as server `panini_service.registry.validate_username`. */
const ACCOUNT_USERNAME_RE = /^[a-z0-9_]{3,24}$/;

function accountUsernameForApi(raw: string): string {
  return raw.trim().toLowerCase();
}

function validateAccountUsername(u: string): string | null {
  if (!ACCOUNT_USERNAME_RE.test(u)) {
    return tr(
      "Username must be 3–24 characters: lowercase letters, digits, and underscore only (no spaces or hyphens).",
    );
  }
  return null;
}

function validateAccountPassword(pw: string): string | null {
  if (pw.length < 8) return tr("Password must be at least 8 characters.");
  return null;
}

/** True if this guest album has anything worth warning before signing in to another account. */
function guestAlbumHasRecoverableData(m: InventoryMetrics): boolean {
  return (
    m.unique_slots_filled > 0 ||
    m.total_physical_stickers > 0 ||
    m.session.packs_opened > 0 ||
    m.session.traded_out_count > 0 ||
    m.session.traded_in_count > 0
  );
}

function buildAccountPanel(onAlbumChanged: () => Promise<void>): HTMLElement {
  const wrap = el("div", { class: "card account-panel" });
  wrap.appendChild(el("h3", { class: "account-panel__title" }, tr("Account")));
  const status = el("p", {
    class: "muted account-panel__status",
    id: "account-status",
  });
  wrap.appendChild(status);

  const signedOut = el("div", { class: "account-panel__signed-out" });
  const signedIn = el("div", { class: "account-panel__signed-in", style: "display:none" });
  const signedInName = el("div", {
    class: "account-panel__signed-in-name ref",
    title: tr("Signed in"),
  });
  const signedInActions = el("div", { class: "account-panel__signed-in-actions" });

  const user = el("input", {
    type: "text",
    placeholder: tr("Username"),
    autocomplete: "username",
    class: "account-panel__input",
    title: tr("3–24 characters: lowercase a–z, 0–9, underscore (server lowercases letters)"),
    spellcheck: false,
    autocapitalize: "off",
  }) as HTMLInputElement;
  const password = el("input", {
    type: "password",
    placeholder: tr("Password"),
    autocomplete: "current-password",
    class: "account-panel__input",
    title: tr("At least 8 characters"),
  }) as HTMLInputElement;

  const err = el("div", { class: "msg-error account-panel__flash", id: "account-err", style: "display:none" });
  const ok = el("div", { class: "msg-ok account-panel__flash", id: "account-ok", style: "display:none" });

  const authRow = el("div", { class: "account-panel__auth-row" });
  const btnLog = el("button", { class: "btn btn-compact", type: "button" }, tr("Sign in"));
  const btnReg = el("button", { class: "btn btn-primary btn-compact", type: "button" }, tr("Register"));
  authRow.append(btnLog, btnReg);

  signedOut.appendChild(user);
  signedOut.appendChild(password);
  signedOut.appendChild(authRow);
  signedOut.appendChild(
    el(
      "p",
      { class: "muted account-panel__hint" },
      tr("Username: 3–24 chars (a–z, 0–9, _). Password: 8+ chars. JSON backup in Overview."),
    ),
  );

  const btnOut = el("button", { class: "btn btn-ghost btn-compact", type: "button" }, tr("Log out"));
  btnOut.addEventListener("click", async () => {
    err.style.display = "none";
    ok.style.display = "none";
    try {
      await logoutUser();
      await refreshStatus();
      await onAlbumChanged();
      ok.textContent = tr("Logged out — new guest album.");
      ok.style.display = "block";
    } catch (e) {
      err.textContent = e instanceof ApiError ? e.message : String(e);
      err.style.display = "block";
    }
  });

  const btnReset = el("button", { class: "btn btn-ghost btn-compact", type: "button" }, tr("Reset album"));
  btnReset.title = tr("Clear all stickers and session counters for this profile.");
  btnReset.addEventListener("click", async () => {
    if (!window.confirm(tr("Reset this album to empty (all slots qty 0, session counters 0)? This cannot be undone.")))
      return;
    err.style.display = "none";
    ok.style.display = "none";
    try {
      await resetAlbum();
      await onAlbumChanged();
      ok.textContent = tr("Album reset.");
      ok.style.display = "block";
    } catch (e) {
      err.textContent = e instanceof ApiError ? e.message : String(e);
      err.style.display = "block";
    }
  });

  signedInActions.append(btnOut, btnReset);
  signedIn.appendChild(signedInName);
  signedIn.appendChild(signedInActions);

  wrap.appendChild(signedOut);
  wrap.appendChild(signedIn);

  function applySignedInUi(displayName: string): void {
    signedInName.textContent = displayName;
    signedOut.style.display = "none";
    signedIn.style.display = "block";
    status.style.display = "none";
  }

  async function refreshStatus(): Promise<void> {
    try {
      const me = await getAuthMe();
      if (me.mode === "user" && me.username) {
        applySignedInUi(me.username);
      } else {
        signedOut.style.display = "block";
        signedIn.style.display = "none";
        status.style.display = "";
        if (me.mode === "legacy") {
          status.textContent = tr("Shared database (legacy).");
        } else {
          status.textContent = tr("Guest — this browser only.");
        }
      }
    } catch (e) {
      status.style.display = "";
      status.textContent = e instanceof Error ? e.message : String(e);
    }
  }

  btnReg.addEventListener("click", async () => {
    err.style.display = "none";
    ok.style.display = "none";
    const username = accountUsernameForApi(user.value);
    const uErr = validateAccountUsername(username);
    if (uErr) {
      err.textContent = uErr;
      err.style.display = "block";
      return;
    }
    const pErr = validateAccountPassword(password.value);
    if (pErr) {
      err.textContent = pErr;
      err.style.display = "block";
      return;
    }
    btnReg.disabled = true;
    try {
      const r = await registerUser(username, password.value);
      ok.textContent = tr("Account created — your guest album was kept.");
      ok.style.display = "block";
      password.value = "";
      applySignedInUi(r.username);
      void refreshStatus();
      void onAlbumChanged();
    } catch (e) {
      err.textContent = e instanceof ApiError ? e.message : String(e);
      err.style.display = "block";
    } finally {
      btnReg.disabled = false;
    }
  });
  btnLog.addEventListener("click", async () => {
    err.style.display = "none";
    ok.style.display = "none";
    const username = accountUsernameForApi(user.value);
    const uErr = validateAccountUsername(username);
    if (uErr) {
      err.textContent = uErr;
      err.style.display = "block";
      return;
    }
    const pErr = validateAccountPassword(password.value);
    if (pErr) {
      err.textContent = pErr;
      err.style.display = "block";
      return;
    }
    btnLog.disabled = true;
    try {
      const me = await getAuthMe();
      if (me.mode === "guest") {
        const m = await getMetrics();
        if (guestAlbumHasRecoverableData(m)) {
          const okGo = window.confirm(
            tr(
              "This guest album has progress (stickers and/or session counters). Signing in loads the account’s saved album from the server — this guest data will be left behind in the browser.\n\nDownload a JSON backup from Overview first if you want a copy.\n\nContinue sign in?",
            ),
          );
          if (!okGo) return;
        }
      }
      const r = await loginUser(username, password.value);
      ok.textContent = tr("Signed in.");
      ok.style.display = "block";
      password.value = "";
      applySignedInUi(r.username);
      void refreshStatus();
      void onAlbumChanged();
    } catch (e) {
      err.textContent = e instanceof ApiError ? e.message : String(e);
      err.style.display = "block";
    } finally {
      btnLog.disabled = false;
    }
  });

  wrap.appendChild(err);
  wrap.appendChild(ok);
  void refreshStatus();
  return wrap;
}

export function initApp(root: HTMLElement): void {
  root.innerHTML = "";
  const sidebar = el("nav", { class: "sidebar" });
  sidebar.appendChild(el("h1", {}, tr("Panini WM26")));
  const routes = [
    ["overview", tr("Overview")],
    ["analytics", tr("Team analytics")],
    ["pack-outlook", tr("Album completion estimate")],
    ["lists", tr("Lists")],
    ["desk", tr("Add stickers")],
    ["trade", tr("Trade")],
    ["crosscheck", tr("Crosscheck")],
  ] as const;
  for (const [id, label] of routes) {
    const b = el("button", { class: "nav-btn", type: "button", "data-route": id }, label);
    if (id === "overview") b.classList.add("active");
    b.addEventListener("click", () => showView(id));
    sidebar.appendChild(b);
  }

  const langRow = el("div", { class: "sidebar-lang-row" });
  const bEn = el("button", { class: "btn btn-ghost btn-compact", type: "button" }, "EN");
  bEn.disabled = getLocale() === "en";
  bEn.addEventListener("click", () => {
    if (getLocale() !== "en") setLocale("en");
  });
  const bEs = el("button", { class: "btn btn-ghost btn-compact", type: "button" }, "ES");
  bEs.disabled = getLocale() === "es";
  bEs.addEventListener("click", () => {
    if (getLocale() !== "es") setLocale("es");
  });
  langRow.append(bEn, bEs);
  sidebar.appendChild(langRow);

  const main = el("main", {});
  main.appendChild(buildOverview());
  sidebar.appendChild(
    buildAccountPanel(async () => {
      await overviewPage.reload();
      void loadTradePreviewData();
    }),
  );
  main.appendChild(buildAnalytics());
  main.appendChild(buildPackOutlook());
  main.appendChild(buildDesk());
  main.appendChild(buildLists());
  main.appendChild(buildTrade());
  main.appendChild(buildCrosscheck());

  root.appendChild(sidebar);
  root.appendChild(main);
  lastNavRoute = "overview";
}

function showView(id: string): void {
  if (lastNavRoute !== null && lastNavRoute !== id) {
    clearStickerDraftsForView(lastNavRoute);
  }
  lastNavRoute = id;
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
  if (id === "crosscheck") {
    void crosscheckPage.reload();
  }
  if (id === "pack-outlook") {
    void packOutlookPage.reload();
  }
}

function setTradePrefillBanner(message: string): void {
  const b = document.getElementById("trade-prefill-banner");
  if (!b) return;
  if (!message) {
    b.style.display = "none";
    b.replaceChildren();
    return;
  }
  b.style.display = "block";
  b.replaceChildren(el("p", { style: "margin:0;font-size:0.88rem;line-height:1.4" }, message));
}

/** Prefill Trade give/take and switch view. Optionally call ``setTradePrefillBanner`` first for a one-line note. */
function albumHintsFromRows(
  dupByCanon: Map<string, ListStickerRow>,
  missingByCanon: Map<string, ListStickerRow>,
): Map<string, AlbumOrderHint> {
  const m = new Map<string, AlbumOrderHint>();
  for (const row of dupByCanon.values()) {
    const c = canonicalRef(row.ref);
    m.set(c, {
      category_code: row.category_code,
      slot_code: row.slot_code,
      album_printed_page: row.album_printed_page,
    });
  }
  for (const row of missingByCanon.values()) {
    const c = canonicalRef(row.ref);
    if (!m.has(c)) {
      m.set(c, {
        category_code: row.category_code,
        slot_code: row.slot_code,
        album_printed_page: row.album_printed_page,
      });
    }
  }
  return m;
}

function applyTradePrefill(give: string[], take: string[], uneven: boolean, albumHints?: Map<string, AlbumOrderHint>): void {
  const giveTa = document.getElementById("trade-give") as HTMLTextAreaElement | null;
  const takeTa = document.getElementById("trade-take") as HTMLTextAreaElement | null;
  const unevenCb = document.getElementById("trade-uneven") as HTMLInputElement | null;
  const g = sortRefsByAlbumOrder([...new Set(give.map((r) => canonicalRef(r)))], albumHints);
  const t = sortRefsByAlbumOrder([...new Set(take.map((r) => canonicalRef(r)))], albumHints);
  if (giveTa) giveTa.value = g.join("\n");
  if (takeTa) takeTa.value = t.join("\n");
  if (unevenCb) unevenCb.checked = uneven;
  showView("trade");
  giveTa?.dispatchEvent(new Event("input"));
  takeTa?.dispatchEvent(new Event("input"));
  void loadTradePreviewData();
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

/** Display % from slot counts — never shows 100% until every unique slot is filled. */
function albumProgressDisplay(filled: number, total: number): {
  labelPct: number;
  barPct: number;
  isComplete: boolean;
} {
  if (total <= 0) return { labelPct: 0, barPct: 0, isComplete: false };
  const isComplete = filled >= total;
  if (isComplete) return { labelPct: 100, barPct: 100, isComplete: true };
  const exact = (100 * filled) / total;
  return { labelPct: Math.floor(exact), barPct: exact, isComplete: false };
}

let prevUniqueSlotsMissing: number | null = null;

function maybeCelebrateAlbumComplete(m: InventoryMetrics): void {
  const missing = m.unique_slots_missing;
  const complete = missing === 0 && m.album_unique_slots > 0 && m.unique_slots_filled >= m.album_unique_slots;
  if (prevUniqueSlotsMissing !== null && prevUniqueSlotsMissing > 0 && complete) {
    showAlbumCompleteCelebration(m);
  }
  prevUniqueSlotsMissing = missing;
}

function spawnCelebrationConfetti(host: HTMLElement, count: number): void {
  const colors = ["#6cb4ee", "#e8c170", "#7bc96f", "#f4a8c8", "#ffffff", "#4a8fc4", "#ffd700"];
  for (let i = 0; i < count; i++) {
    const p = document.createElement("div");
    p.className = "album-celebration__confetti";
    p.style.setProperty("--x", `${Math.random() * 100}%`);
    p.style.setProperty("--delay", `${Math.random() * 0.9}s`);
    p.style.setProperty("--dur", `${2.4 + Math.random() * 2.2}s`);
    p.style.setProperty("--rot", `${Math.random() * 720 - 360}deg`);
    p.style.setProperty("--drift", `${(Math.random() - 0.5) * 120}px`);
    p.style.background = colors[i % colors.length]!;
    host.appendChild(p);
  }
}

function showAlbumCompleteCelebration(m: InventoryMetrics): void {
  if (document.querySelector(".album-celebration")) return;

  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const overlay = el("div", {
    class: "album-celebration",
    role: "dialog",
    "aria-modal": "true",
    "aria-labelledby": "album-celebration-title",
  });
  const backdrop = el("button", {
    class: "album-celebration__backdrop",
    type: "button",
    "aria-label": tr("Close celebration"),
  });
  const confettiHost = el("div", { class: "album-celebration__confetti-host", "aria-hidden": "true" });
  if (!reduceMotion) spawnCelebrationConfetti(confettiHost, 96);

  const card = el("div", { class: "album-celebration__card" });
  const seal = el("div", { class: "album-celebration__seal" }, tr("COMPLETE"));
  const trophy = el("div", { class: "album-celebration__trophy", "aria-hidden": "true" }, "🏆");
  const eyebrow = el("p", { class: "album-celebration__eyebrow" }, tr("Every unique slot — filled."));
  const title = el("h2", { id: "album-celebration-title", class: "album-celebration__title" }, tr("The album is yours."));
  const lede = el(
    "p",
    { class: "album-celebration__lede" },
    trf("All {total} stickers accounted for. The hunt ends here — for now.", { total: String(m.album_unique_slots) }),
  );
  const quote = el(
    "blockquote",
    { class: "album-celebration__quote" },
    tr("From the first rip of cellophane to the last handshake swap: done."),
  );

  const stats = el("div", { class: "album-celebration__stats" });
  const statItems: [string, string][] = [
    [tr("Unique slots"), String(m.unique_slots_filled)],
    [tr("Spares left"), String(m.spare_copies)],
    [tr("Packs opened"), String(m.session.packs_opened)],
    [tr("Traded out"), String(m.session.traded_out_count)],
  ];
  for (const [label, val] of statItems) {
    const chip = el("div", { class: "album-celebration__stat" });
    chip.appendChild(el("span", { class: "album-celebration__stat-val" }, val));
    chip.appendChild(el("span", { class: "album-celebration__stat-label" }, label));
    stats.appendChild(chip);
  }

  const actions = el("div", { class: "album-celebration__actions" });
  const dismiss = el("button", { class: "btn btn-primary album-celebration__dismiss", type: "button" }, tr("Back to the desk"));
  actions.appendChild(dismiss);

  card.append(seal, trophy, eyebrow, title, lede, quote, stats, actions);
  overlay.append(backdrop, confettiHost, card);
  document.body.appendChild(overlay);
  document.body.classList.add("album-celebration-open");

  const close = (): void => {
    overlay.classList.add("album-celebration--closing");
    window.setTimeout(() => {
      overlay.remove();
      document.body.classList.remove("album-celebration-open");
    }, reduceMotion ? 120 : 420);
  };

  backdrop.addEventListener("click", close);
  dismiss.addEventListener("click", close);
  overlay.addEventListener("keydown", (ev) => {
    if ((ev as KeyboardEvent).key === "Escape") close();
  });
  window.setTimeout(() => dismiss.focus(), reduceMotion ? 0 : 480);
}

function analyticsPctRing(pct: number, innerLabel?: string): HTMLElement {
  const p = Math.min(100, Math.max(0, pct));
  const outer = el("div", { class: "pct-ring-outer" });
  outer.style.setProperty("--pct", String(p));
  const inner = el("div", { class: "pct-ring-inner" });
  inner.appendChild(el("span", { class: "pct-ring-val" }, `${Math.floor(p)}%`));
  if (innerLabel) inner.appendChild(el("span", { class: "pct-ring-sub" }, innerLabel));
  outer.appendChild(inner);
  return outer;
}

function analyticsPctRingFromSlots(filled: number, total: number, innerLabel?: string): HTMLElement {
  const { labelPct, barPct } = albumProgressDisplay(filled, total);
  const outer = el("div", { class: "pct-ring-outer" });
  outer.style.setProperty("--pct", String(barPct));
  const inner = el("div", { class: "pct-ring-inner" });
  inner.appendChild(el("span", { class: "pct-ring-val" }, `${labelPct}%`));
  if (innerLabel) inner.appendChild(el("span", { class: "pct-ring-sub" }, innerLabel));
  outer.appendChild(inner);
  return outer;
}

/** Large % + progress bar for unique-slot completion (Overview). */
function collectionProgressBlock(filled: number, total: number): HTMLElement {
  const { labelPct, barPct, isComplete } = albumProgressDisplay(filled, total);
  const wrap = el("div", { class: `collection-progress${isComplete ? " collection-progress--complete" : ""}` });
  const head = el("div", { class: "collection-progress-head" });
  head.appendChild(el("span", { class: "collection-progress-pct" }, `${labelPct}%`));
  head.appendChild(
    el("span", { class: "collection-progress-meta" }, trf("{filled} / {total} unique", { filled: String(filled), total: String(total) })),
  );
  wrap.appendChild(head);
  const track = el("div", {
    class: "collection-progress-track",
    role: "progressbar",
    "aria-valuenow": String(labelPct),
    "aria-valuemin": "0",
    "aria-valuemax": "100",
    "aria-label": trf("Album {pct} percent complete", { pct: String(labelPct) }),
  });
  const fill = el("div", { class: "collection-progress-fill" });
  fill.style.width = `${barPct}%`;
  track.appendChild(fill);
  wrap.appendChild(track);
  return wrap;
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

type RenderAnalyticsOpts = {
  /** No unique slots filled yet — avoid huge “all teams tied” copy. */
  emptyAlbum?: boolean;
};

function tieOrEmptyNote(
  emptyAlbum: boolean,
  tied: boolean,
  tieNote: string,
  whenEmpty: string,
): HTMLElement | null {
  if (!tied) return null;
  const text = emptyAlbum ? tr(whenEmpty) : trTieNote(tieNote);
  if (!text) return null;
  return formatTieNote(text);
}

/** Rich overview cards from `GET /analytics` (replaces raw JSON dump). */
function renderAnalyticsWidgets(data: Record<string, unknown>, opts?: RenderAnalyticsOpts): HTMLElement {
  const grid = el("div", { class: "analytics-widget-grid" });
  const emptyAlbum = opts?.emptyAlbum === true;

  const repeated = _rec(data.most_repeated);
  if (repeated) {
    const ref = _str(repeated.ref, "?");
    const qty = _num(repeated.qty, 0);
    const album = _str(repeated.album_code, "");
    const sub = album ? `${ref} · album ${album}` : ref;
    const w = el("article", { class: "stat-widget stat-widget--gold" });
    w.appendChild(el("div", { class: "stat-widget__eyebrow" }, tr("Duplicate champion")));
    if (emptyAlbum && qty === 0) {
      w.appendChild(
        el(
          "p",
          { class: "stat-widget__hint", style: "margin:0" },
          tr("Nothing to rank yet — add stickers to see which ref piles up the most."),
        ),
      );
    } else {
      w.appendChild(el("div", { class: "stat-widget__hero ref" }, ref));
      w.appendChild(el("div", { class: "stat-widget__metric" }, el("span", { class: "stat-widget__qty" }, `×${qty}`), tr(" in the stack")));
      w.appendChild(el("p", { class: "stat-widget__hint" }, sub));
    }
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
    w.appendChild(el("div", { class: "stat-widget__eyebrow" }, tr("Most duplicated team")));
    w.appendChild(el("div", { class: "stat-widget__hero ref" }, code));
    w.appendChild(
      el(
        "div",
        { class: "stat-widget__metric" },
        el("span", { class: "stat-widget__qty" }, `+${spare}`),
        tr(" spare copies on this page"),
      ),
    );
    w.appendChild(
      el(
        "p",
        { class: "stat-widget__hint" },
        trf("{n} slots with qty>1 · sum of extras beyond the first copy each", { n: String(slotsDup) }),
      ),
    );
    const tieDup = tieOrEmptyNote(
      emptyAlbum,
      tied,
      tieNote,
      "All teams are tied until you have stickers on the pages.",
    );
    if (tieDup) w.appendChild(tieDup);
    w.appendChild(analyticsHBar(Math.min(100, pctSlots)));
    grid.appendChild(w);
  }

  const best = _rec(data.most_completed_team);
  if (best) {
    const allDone = _bool(best.all_teams_complete);
    const w = el("article", { class: "stat-widget stat-widget--team" });
    w.appendChild(el("div", { class: "stat-widget__eyebrow" }, tr("Closest to complete")));
    const row = el("div", { class: "stat-widget__row" });
    if (allDone) {
      row.appendChild(analyticsPctRing(100, "20/20"));
      const col = el("div", { class: "stat-widget__col" });
      col.appendChild(el("div", { class: "stat-widget__title" }, tr("All national teams")));
      col.appendChild(
        el(
          "p",
          { class: "stat-widget__hint" },
          tr("Every team page has all 20 stickers (at least one copy each)."),
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
          trf("{have} slots with at least one copy · {miss} still empty on this page", {
            have: String(have),
            miss: String(miss),
          }),
        ),
      );
      const tieBest = tieOrEmptyNote(
        emptyAlbum,
        tied,
        tieNote,
        "Every national team page is still at 0/20 — add stickers to see who pulls ahead.",
      );
      if (tieBest) col.appendChild(tieBest);
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
    w.appendChild(el("div", { class: "stat-widget__eyebrow" }, tr("Hunt zone")));
    const row = el("div", { class: "stat-widget__row" });
    row.appendChild(analyticsPctRing(pct, `${20 - miss}/20`));
    const col = el("div", { class: "stat-widget__col" });
    col.appendChild(el("div", { class: "stat-widget__code" }, code));
    col.appendChild(
      el(
        "p",
        { class: "stat-widget__hint" },
        trf("{miss} stickers still missing here — trade priority?", { miss: String(miss) }),
      ),
    );
    const tieWorst = tieOrEmptyNote(
      emptyAlbum,
      tied,
      tieNote,
      "Every team still has all 20 slots missing — rankings appear once you start filling the album.",
    );
    if (tieWorst) col.appendChild(tieWorst);
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
    w.appendChild(el("div", { class: "stat-widget__eyebrow" }, tr("Specials")));
    const row = el("div", { class: "stat-widget__row" });
    row.appendChild(analyticsPctRing(pct, `${have}/${total}`));
    const col = el("div", { class: "stat-widget__col" });
    col.appendChild(el("div", { class: "stat-widget__title" }, name));
    col.appendChild(
      el("p", { class: "stat-widget__hint" }, trf("{miss} missing in this sheet", { miss: String(miss) })),
    );
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
      w.appendChild(el("div", { class: "stat-widget__eyebrow" }, tr("Team shields")));
      w.appendChild(
        el("p", { class: "stat-widget__hint", style: "margin:0 0 0.35rem" }, tr("Slot 1 on every team page (48 crest stickers).")),
      );
      const row = el("div", { class: "stat-widget__row" });
      row.appendChild(analyticsPctRing(pct, `${have}/${total}`));
      const col = el("div", { class: "stat-widget__col" });
      col.appendChild(
        el("div", { class: "stat-widget__title" }, trf("{have} of {total} in the album", { have: String(have), total: String(total) })),
      );
      col.appendChild(
        el(
          "p",
          { class: "stat-widget__hint" },
          miss === 0
            ? tr("All shields accounted for.")
            : trf("{miss} shields still missing.", { miss: String(miss) }),
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
      w.appendChild(el("div", { class: "stat-widget__eyebrow" }, tr("Team photos")));
      w.appendChild(
        el("p", { class: "stat-widget__hint", style: "margin:0 0 0.35rem" }, tr("Slot 13 on every team page (48 squad photos).")),
      );
      const row = el("div", { class: "stat-widget__row" });
      row.appendChild(analyticsPctRing(pct, `${have}/${total}`));
      const col = el("div", { class: "stat-widget__col" });
      col.appendChild(
        el("div", { class: "stat-widget__title" }, trf("{have} of {total} in the album", { have: String(have), total: String(total) })),
      );
      col.appendChild(
        el(
          "p",
          { class: "stat-widget__hint" },
          miss === 0
            ? tr("All team photos accounted for.")
            : trf("{miss} photos still missing.", { miss: String(miss) }),
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
    w.appendChild(el("div", { class: "stat-widget__eyebrow" }, tr("Full team pages")));
    w.appendChild(
      el(
        "p",
        { class: "stat-widget__hint", style: "margin:0 0 0.35rem" },
        tr("National teams with all 20 stickers present (≥1 copy each)."),
      ),
    );
    const row = el("div", { class: "stat-widget__row" });
    row.appendChild(analyticsPctRing(pct, `${n}/${total}`));
    const col = el("div", { class: "stat-widget__col" });
    col.appendChild(
      el("div", { class: "stat-widget__title" }, trf("{n} of {total} complete", { n: String(n), total: String(total) })),
    );
    col.appendChild(
      el(
        "p",
        { class: "stat-widget__hint" },
        rest === 0
          ? tr("Every team sheet is finished.")
          : trf("{rest} team sheets still incomplete — open Team analytics.", { rest: String(rest) }),
      ),
    );
    col.appendChild(analyticsHBar(pct));
    row.appendChild(col);
    w.appendChild(row);
    grid.appendChild(w);
  }

  if (!grid.children.length) {
    grid.appendChild(
      el("p", { class: "stat-widget__empty", style: "margin:0;color:var(--muted)" }, tr("No analytics yet — add some stickers first.")),
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
  section.appendChild(el("h2", {}, tr("Team analytics")));
  section.appendChild(
    el(
      "p",
      { class: "muted", style: "margin:0 0 1rem;font-size:0.95rem;max-width:52rem" },
      tr(
        "Each row is one national team page (20 stickers). Stickers counts every copy you own on that page (including spares). Shield is slot 1, team photo is slot 13. Click column headers to sort.",
      ),
    ),
  );
  const host = el("div", { id: "analytics-teams-host" });

  type TeamSortKey = "code" | "pct_complete" | "total_stickers" | "shield_ok" | "team_photo_ok";
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
      case "total_stickers":
        if (a.total_stickers !== b.total_stickers) return (a.total_stickers - b.total_stickers) * d;
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
    const row = el("tr", {});
    row.appendChild(el("td", { class: "ref" }, t.code));
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
    row.appendChild(pctCell);
    const stickersCell = el("td", { class: "team-stickers-cell ref" });
    stickersCell.appendChild(el("span", { class: "team-stickers-val" }, String(t.total_stickers)));
    if (t.total_stickers > t.slots_with_copy) {
      stickersCell.appendChild(
        el(
          "span",
          { class: "muted team-stickers-spares", style: "display:block;font-size:0.78rem;margin-top:0.15rem" },
          trf("+{n} extras", { n: String(t.total_stickers - t.slots_with_copy) }),
        ),
      );
    }
    row.appendChild(stickersCell);
    row.appendChild(
      el(
        "td",
        { class: "team-flag-cell" },
        flagCell(t.shield_ok, t.shield_ok ? tr("Shield in album") : tr("Shield missing")),
      ),
    );
    row.appendChild(
      el(
        "td",
        { class: "team-flag-cell" },
        flagCell(t.team_photo_ok, t.team_photo_ok ? tr("Team photo in album") : tr("Team photo missing")),
      ),
    );
    return row;
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
    host.appendChild(el("p", { class: "muted" }, tr("Loading…")));
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
          el("th", { class: "th-sortable", "data-sort": "code", title: tr("Album order · click to sort") }, tr("Team")),
          el("th", { class: "th-sortable", "data-sort": "pct_complete", title: tr("Click to sort by completion %") }, tr("% complete")),
          el("th", {
            class: "th-sortable",
            "data-sort": "total_stickers",
            title: tr("Total copies on this team page (including spares) · click to sort"),
          }, tr("Stickers")),
          el("th", {
            class: "th-sortable",
            "data-sort": "shield_ok",
            title: tr("Slot 1 — shield / crest · click to sort"),
          }, tr("Shield")),
          el("th", {
            class: "th-sortable",
            "data-sort": "team_photo_ok",
            title: tr("Slot 13 — squad photo · click to sort"),
          }, tr("Photo")),
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
  section.appendChild(el("h2", {}, tr("Overview")));

  const startCard = el("div", { class: "card overview-start-card" });
  startCard.appendChild(el("h3", { style: "margin-top:0" }, tr("Add stickers to your album")));
  startCard.appendChild(
    el(
      "p",
      { class: "muted", style: "margin:0 0 0.65rem;font-size:0.9rem;line-height:1.45" },
      tr("Paste sticker refs (e.g. MEX:5 or one line per sticker from a pack). Use Add stickers in the sidebar."),
    ),
  );
  const goAdd = el("button", { class: "btn btn-primary", type: "button" }, tr("Go to Add stickers"));
  goAdd.addEventListener("click", () => showView("desk"));
  startCard.appendChild(goAdd);
  section.appendChild(startCard);

  const metricsHost = el("div", { class: "card" });
  const analyticsHost = el("div", { class: "card" });
  const sessionHost = el("div", { class: "card" });
  const ioHost = el("div", { class: "card" });

  section.append(metricsHost, analyticsHost, sessionHost, ioHost);

  const sessionMsg = el("div", { class: "msg-ok" });
  const sessionErr = el("div", { class: "msg-error" });

  const lastSession = { packs: 0, out: 0, inn: 0, dupRate: null as number | null };
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
    dupRate: el("span", { class: "session-info-val" }),
  };

  const sessionReadHost = el("div", { class: "session-readonly" });
  function sessionAddReadRow(label: string, valEl: HTMLElement): void {
    const row = el("div", { class: "session-info-row" });
    row.appendChild(el("span", { class: "session-info-label" }, label));
    row.appendChild(valEl);
    sessionReadHost.appendChild(row);
  }
  sessionAddReadRow(tr("Packs opened"), sessionReadVals.packs);
  sessionAddReadRow(tr("Traded out"), sessionReadVals.out);
  sessionAddReadRow(tr("Traded in"), sessionReadVals.inn);
  sessionAddReadRow(tr("Duplicate trade rate"), sessionReadVals.dupRate);
  sessionReadVals.dupRate.title = tr("Traded out ÷ (traded out + spares still held)");

  const sessionEditHost = el("div", { class: "session-edit-host" });
  sessionEditHost.style.display = "none";
  const sg = el("div", { class: "session-grid" });
  sg.appendChild(el("div", {}, el("label", { class: "field" }, tr("Packs opened")), sessionInputs.packs));
  sg.appendChild(el("div", {}, el("label", { class: "field" }, tr("Traded out")), sessionInputs.out));
  sg.appendChild(el("div", {}, el("label", { class: "field" }, tr("Traded in")), sessionInputs.inn));
  sessionEditHost.appendChild(sg);
  const editActions = el("div", { class: "session-edit-actions" });
  const saveSession = el("button", { class: "btn btn-primary", type: "button" }, tr("Save"));
  const cancelSession = el("button", { class: "btn", type: "button" }, tr("Cancel"));
  editActions.append(saveSession, cancelSession);
  sessionEditHost.appendChild(editActions);

  const sessionHead = el("div", { class: "session-head" });
  sessionHead.appendChild(el("h3", {}, tr("Session")));
  const editSessionBtn = el("button", { class: "btn", type: "button" }, tr("Edit"));
  sessionHead.appendChild(editSessionBtn);

  function applySessionToUI(): void {
    sessionReadVals.packs.textContent = String(lastSession.packs);
    sessionReadVals.out.textContent = String(lastSession.out);
    sessionReadVals.inn.textContent = String(lastSession.inn);
    sessionReadVals.dupRate.textContent = formatSessionDuplicateTradeRate(lastSession.dupRate);
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
      sessionMsg.textContent = tr("Saved.");
    } catch (e) {
      sessionErr.replaceChildren(errBox(e));
    }
  });

  async function loadMetrics(): Promise<void> {
    metricsHost.innerHTML = tr("<p class='muted'>Loading…</p>");
    analyticsHost.innerHTML = "";
    const [mRes, anRes] = await Promise.allSettled([getMetrics(), getAnalytics()]);

    if (mRes.status === "rejected") {
      metricsHost.innerHTML = "";
      metricsHost.appendChild(errBox(mRes.reason));
      analyticsHost.innerHTML = "";
      return;
    }

    const m = mRes.value;
    maybeCelebrateAlbumComplete(m);
    const emptyAlbum = m.unique_slots_filled === 0;
    metricsHost.innerHTML = "";
    metricsHost.appendChild(el("h3", {}, tr("Collection")));
    metricsHost.appendChild(collectionProgressBlock(m.unique_slots_filled, m.album_unique_slots));
    const g = el("div", { class: "grid-metrics" });
    const cells: [string, string][] = [
      [tr("Missing"), String(m.unique_slots_missing)],
      [tr("Filled"), String(m.unique_slots_filled)],
      [tr("Spares"), String(m.spare_copies)],
      [tr("Total stickers"), String(m.total_physical_stickers)],
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
    lastSession.dupRate = m.session.duplicate_trade_rate ?? null;
    applySessionToUI();
    if (sessionEditing) leaveSessionEdit();

    if (anRes.status === "fulfilled") {
      const an = anRes.value;
      analyticsHost.innerHTML = "";
      analyticsHost.appendChild(el("h3", {}, tr("Analytics")));
      analyticsHost.appendChild(renderAnalyticsWidgets(an, { emptyAlbum }));
      const foot = el("p", { class: "analytics-card-foot" });
      const link = el("a", { href: "#", class: "analytics-full-link" }, tr("Open team analytics"));
      link.addEventListener("click", (ev) => {
        ev.preventDefault();
        showView("analytics");
      });
      foot.appendChild(link);
      analyticsHost.appendChild(foot);
    } else {
      analyticsHost.innerHTML = "";
      analyticsHost.appendChild(el("h3", {}, tr("Analytics")));
      analyticsHost.appendChild(errBox(anRes.reason));
    }
  }

  sessionHost.appendChild(sessionHead);
  sessionHost.appendChild(
    el("p", { class: "muted", style: "margin:0 0 0.75rem;font-size:0.85rem" }, tr("From packs and trades. Edit if you need to fix counts.")),
  );
  sessionHost.appendChild(sessionReadHost);
  sessionHost.appendChild(sessionEditHost);
  sessionHost.appendChild(sessionMsg);
  sessionHost.appendChild(sessionErr);

  ioHost.appendChild(el("h3", {}, tr("Backup")));
  const ioRow = el("div", { class: "row" });
  const exportBtn = el("button", { class: "btn btn-primary", type: "button" }, tr("Download snapshot JSON"));
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
  const printLink = el("a", { href: listsPrintUrl(), target: "_blank", rel: "noopener" }, tr("Open printable sheet"));
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
    el("div", { class: "checkbox-row" }, applySess, el("label", {}, tr("Include session counters"))),
  );
  ioHost.appendChild(el("label", { class: "field" }, tr("Import snapshot JSON")));
  ioHost.appendChild(fileInput);
  ioHost.appendChild(importMsg);
  ioHost.appendChild(importErr);

  const refresh = el("button", { class: "btn", type: "button" }, tr("Refresh"));
  refresh.addEventListener("click", () => loadMetrics());
  section.insertBefore(refresh, metricsHost);

  overviewPage.reload = loadMetrics;
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
  if (status === "missing") return tr("Missing");
  if (status === "duplicate") return tr("Duplicates");
  return tr("In album");
}

/** Session observed duplicate trade rate (0–1) as a percent label, or em dash if undefined. */
function formatSessionDuplicateTradeRate(rate: number | null | undefined): string {
  if (rate == null || Number.isNaN(rate)) return tr("—");
  return `${Math.round(rate * 100)}%`;
}

type StickerActionLine = {
  ref: string;
  isNew: boolean;
  page: number;
  group: string | null;
  category_code: string;
  qtyBefore?: number;
};

function countStickerActionLines(lines: StickerActionLine[]): { newCount: number; spareCount: number } {
  let newCount = 0;
  let spareCount = 0;
  for (const ln of lines) {
    if (ln.isNew) newCount++;
    else spareCount++;
  }
  return { newCount, spareCount };
}

function formatStickerRowNewSlot(ln: StickerActionLine): string {
  const grp = ln.group != null && ln.group !== "" ? `Gr. ${ln.group} · ` : "";
  return ln.page >= 0 ? `${ln.ref} · ${grp}p.${ln.page}` : ln.ref;
}

function formatStickerRowDupSlot(ln: StickerActionLine): string {
  const base = formatStickerRowNewSlot(ln);
  return ln.qtyBefore != null ? `${base} (qty before ${ln.qtyBefore})` : base;
}

function appendStickerSummaryColumn(
  title: string,
  lines: StickerActionLine[],
  emptyMsg: string,
  colMod: string,
  formatRow: (ln: StickerActionLine) => string,
): HTMLElement {
  const col = el("div", { class: `trade-result-col ${colMod}` });
  col.appendChild(el("div", { class: "trade-result-col-title" }, title));
  if (lines.length === 0) {
    col.appendChild(el("p", { class: "trade-result-empty" }, emptyMsg));
  } else {
    const ul = el("ul", { class: "compact-list", style: "margin:0;padding-left:1.1rem;font-size:0.88rem" });
    for (const ln of lines) {
      ul.appendChild(el("li", {}, formatRow(ln)));
    }
    col.appendChild(ul);
  }
  return col;
}

function renderStickerOrderedList(lines: StickerActionLine[], title: string): HTMLElement {
  const wrap = el("div");
  wrap.appendChild(
    el(
      "div",
      { class: "pack-preview-ordered-title muted", style: "font-size:0.82rem;margin-bottom:0.35rem" },
      title,
    ),
  );
  const ol = el("ol", { class: "pack-preview-ordered-list compact-list" });
  for (const ln of lines) {
    const grp = ln.group != null && ln.group !== "" ? ` · ${tr("Group")} ${ln.group}` : "";
    const pageStr = ln.page >= 0 ? ` · ${tr("Page")} ${ln.page}` : "";
    const typeLbl = stickerTypeShortLabel(ln.category_code, null);
    const action = ln.isNew ? tr("New to album") : tr("Adds spare");
    const badgeClass = ln.isNew ? "lookup-badge lookup-badge--ok" : "lookup-badge lookup-badge--dup";
    const li = el("li", { class: "pack-preview-ordered-line" });
    li.appendChild(el("span", { class: "ref pack-preview-ordered-ref" }, ln.ref));
    li.appendChild(el("span", { class: badgeClass, style: "margin:0 0.35rem;font-size:0.78rem" }, action));
    li.appendChild(el("span", { class: "muted", style: "font-size:0.82rem" }, `${typeLbl}${pageStr}${grp}`));
    ol.appendChild(li);
  }
  wrap.appendChild(ol);
  return wrap;
}

function renderStickerActionSummaryGrid(
  host: HTMLElement,
  lines: StickerActionLine[],
  countsText: string,
): void {
  host.appendChild(
    el("p", { class: "muted pack-preview-counts", style: "margin:0 0 0.65rem;font-size:0.9rem" }, countsText),
  );
  const grid = el("div", { class: "trade-result-grid" });
  grid.appendChild(
    appendStickerSummaryColumn(
      tr("Goes to album (empty slot)"),
      lines.filter((ln) => ln.isNew),
      tr("None — every line is already in the album at least once."),
      "trade-result-col--in",
      formatStickerRowNewSlot,
    ),
  );
  grid.appendChild(
    appendStickerSummaryColumn(
      tr("Adds spare / duplicate"),
      lines.filter((ln) => !ln.isNew),
      tr("None — every line fills a missing slot."),
      "trade-result-col--out",
      formatStickerRowDupSlot,
    ),
  );
  host.appendChild(grid);
}

function buildTradeAlbumHintMap(): Map<string, TradeAlbumHint> {
  const hints = new Map<string, TradeAlbumHint>();
  if (tradeMissingHints) {
    for (const [k, v] of tradeMissingHints) hints.set(k, v);
  }
  for (const r of tradeDupRows) {
    const c = canonicalRef(r.ref);
    if (!hints.has(c)) {
      hints.set(c, {
        category_code: r.category_code,
        album_printed_page: r.album_printed_page,
        album_index_group: r.album_index_group,
      });
    }
  }
  return hints;
}

function buildOrderedTradeReceiveLines(
  forwardTake: string[],
  received: TradeResponse["received"],
  hints: Map<string, TradeAlbumHint>,
): StickerActionLine[] {
  const lines: StickerActionLine[] = [];
  for (let i = 0; i < forwardTake.length; i++) {
    const rec = received[i];
    if (!rec) continue;
    const c = canonicalRef(forwardTake[i]!);
    const hint = hints.get(c);
    lines.push({
      ref: c,
      isNew: rec.qty_before === 0,
      qtyBefore: rec.qty_before,
      page: hint?.album_printed_page ?? -1,
      group: hint?.album_index_group ?? null,
      category_code: hint?.category_code ?? c.split(":")[0] ?? "",
    });
  }
  return lines;
}

/** Compact album lines: `Group:` when applicable, `Page:`, always `Type:`. */
function renderLookupAlbumKv(r: StickerDetail): HTMLElement {
  const page = r.album_printed_page;
  const hasPage = typeof page === "number" && page >= 0;
  const grp = r.album_index_group;
  const hasGroup = typeof grp === "string" && grp.trim().length > 0;
  const box = el("div", { class: "lookup-album-kv" });
  if (hasGroup) {
    box.appendChild(el("div", { class: "lookup-album-kv-line" }, `${tr("Group")}: ${grp}`));
  }
  if (hasPage) {
    box.appendChild(el("div", { class: "lookup-album-kv-line" }, `${tr("Page")}: ${page}`));
  }
  box.appendChild(
    el("div", { class: "lookup-album-kv-line" }, `${tr("Type")}: ${stickerTypeShortLabel(r.category_code, r.role)}`),
  );
  return box;
}

/** Album / paste line text for clipboard and compact tables (FWC 00 without FWC prefix). */
function albumPasteLineForDetail(r: StickerDetail): string {
  const rawPaste = typeof r.album_paste_line === "string" ? r.album_paste_line.trim() : "";
  let paste =
    rawPaste ||
    (r.category_code === "FWC" && r.album_code ? `FWC ${r.album_code}` : `${r.category_code} ${r.slot_code}`);
  if (r.role === "fwc_special") {
    const p = r.album_printed_page;
    const ac = r.album_code ?? "00";
    paste = typeof p === "number" ? `${ac} | p.${p}` : ac;
  }
  return paste;
}

function renderLookupResult(r: StickerDetail): HTMLElement {
  const host = el("div", { class: "lookup-result" });
  const displayRef = albumStickerRefLabel(r);
  host.appendChild(el("div", { class: "lookup-result-ref ref" }, displayRef));

  const albumKv = renderLookupAlbumKv(r);
  host.appendChild(albumKv);

  const top = el("div", { class: "lookup-result-top" });
  top.appendChild(el("span", { class: lookupStatusBadgeClass(r.status) }, formatLookupStatusLabel(r.status)));
  top.appendChild(
    el(
      "span",
      { class: "lookup-result-counts" },
      `${r.qty} in your stack | ${r.spare_copies} spare${r.spare_copies === 1 ? "" : "s"}`,
    ),
  );
  host.appendChild(top);

  const paste = albumPasteLineForDetail(r);
  if (paste) {
    const pasteCard = el("div", { class: "lookup-paste-card" });
    pasteCard.appendChild(el("div", { class: "lookup-paste-label" }, tr("Album / paste line")));
    pasteCard.appendChild(el("div", { class: "lookup-paste-line ref" }, paste));
    const btnRow = el("div", { class: "lookup-paste-actions" });
    const copyAlbum = el("button", { class: "btn btn-primary", type: "button" }, tr("Copy album line"));
    copyAlbum.addEventListener("click", async () => {
      try {
        await copyTextToClipboard(paste);
        copyAlbum.textContent = tr("Copied!");
        setTimeout(() => {
          copyAlbum.textContent = tr("Copy album line");
        }, 1600);
      } catch {
        copyAlbum.textContent = "Copy failed";
      }
    });
    const copyRef = el("button", { class: "btn", type: "button" }, tr("Copy app ref"));
    copyRef.addEventListener("click", async () => {
      try {
        await copyTextToClipboard(r.ref);
        copyRef.textContent = tr("Copied!");
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

  if (displayRef !== r.ref && r.role !== "fwc_special") {
    host.appendChild(el("p", { class: "lookup-result-meta" }, `${tr("App ref")}: ${r.ref}`));
  }

  return host;
}

function buildLists(): HTMLElement {
  const section = el("section", { class: "view", id: "view-lists" });
  views.lists = section;
  section.appendChild(el("h2", {}, tr("Lists")));

  const lead = el("p", { class: "lists-lead" });
  lead.textContent = "Loading…";
  section.appendChild(lead);

  const toolbar = el("div", { class: "lists-toolbar" });
  const loadBtn = el("button", { class: "btn btn-primary", type: "button" }, tr("Reload"));
  const copyMiss = el("button", {
    class: "btn",
    type: "button",
    title: "Copy compact missing list",
  }, tr("Copy missing"));
  copyMiss.addEventListener("click", async () => {
    try {
      const t = await getMissingCompact();
      await copyTextToClipboard(t);
      copyMiss.textContent = tr("Copied!");
      setTimeout(() => {
        copyMiss.textContent = tr("Copy missing");
      }, 1500);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  });
  const copyDup = el("button", {
    class: "btn",
    type: "button",
    title: "Copy compact duplicates list",
  }, tr("Copy dups"));
  copyDup.addEventListener("click", async () => {
    try {
      const t = await getDuplicatesCompact();
      await copyTextToClipboard(t);
      copyDup.textContent = tr("Copied!");
      setTimeout(() => {
        copyDup.textContent = tr("Copy dups");
      }, 1500);
    } catch (e) {
      alert(e instanceof Error ? e.message : String(e));
    }
  });
  const printLink = el(
    "a",
    { href: listsPrintUrl(), target: "_blank", rel: "noopener", class: "lists-print-link", title: "Opens printable page" },
    "Print",
  );
  toolbar.append(loadBtn, copyMiss, copyDup, printLink);
  section.appendChild(toolbar);

  const searchWrap = el("div", { class: "lists-search-wrap" });
  const searchField = el("div", { class: "lists-search-field" });
  const searchInput = el("input", {
    type: "text",
    class: "lists-search-input",
    placeholder: tr("Filter or ref (e.g. MEX:1) · Enter = look up"),
    autocomplete: "off",
    spellcheck: false,
    "data-sticker-draft": "1",
  }) as HTMLInputElement;
  searchField.appendChild(searchInput);
  const searchGo = el("button", { class: "btn btn-primary", type: "button" }, tr("Look up"));
  searchWrap.append(searchField, searchGo);
  section.appendChild(searchWrap);
  attachStickerRefAutocomplete(searchInput);

  const listsMain = el("div", { class: "lists-main" });

  const albumToolbar = el("div", { class: "lists-album-toolbar" });
  const typeFilter = el("select", {
    class: "lists-album-filter",
    "aria-label": tr("Filter by sticker type"),
  }) as HTMLSelectElement;
  for (const [val, lab] of [
    ["all", "All types"],
    ["Shield", "Shield"],
    ["Player", "Player"],
    ["Team picture", "Team picture"],
    ["Special", "Special"],
  ] as const) {
    typeFilter.appendChild(el("option", { value: val }, tr(lab)));
  }
  const statusFilter = el("select", {
    class: "lists-album-filter",
    "aria-label": tr("Filter by inventory status"),
  }) as HTMLSelectElement;
  for (const [val, lab] of [
    ["all", "All statuses"],
    ["missing", "Missing"],
    ["duplicate", "Duplicates"],
    ["single", "In album"],
  ] as const) {
    statusFilter.appendChild(el("option", { value: val }, tr(lab)));
  }
  albumToolbar.append(typeFilter, statusFilter);

  const legend = el("div", { class: "lists-legend", "aria-label": tr("Sticker type colors") });
  legend.appendChild(el("span", { class: "lists-legend-title" }, tr("Types")));
  const legendPairs: [string, string][] = [
    ["lists-line-ref--shield", "Shield"],
    ["lists-line-ref--photo", "Team picture"],
    ["lists-line-ref--fwc-sp", "Special"],
    ["lists-line-ref--fwc", "Special"],
    ["lists-line-ref--player", "Player"],
  ];
  for (const [cls, label] of legendPairs) {
    legend.appendChild(document.createTextNode(" · "));
    legend.appendChild(el("span", { class: `lists-legend-chip ${cls}` }, tr(label)));
  }

  const albumScroll = el("div", { class: "lists-album-scroll" });
  const albumTable = el("table", { class: "lists-album-table data" });
  const albumThead = el(
    "thead",
    {},
    el(
      "tr",
      {},
      el("th", { scope: "col" }, tr("Ref")),
      el("th", { scope: "col" }, "Type"),
      el("th", { scope: "col" }, tr("Group")),
      el("th", { scope: "col" }, tr("Page")),
      el("th", { scope: "col" }, tr("Status")),
      el("th", { scope: "col" }, tr("Qty")),
      el("th", { scope: "col" }, tr("Spare")),
    ),
  );
  const albumTbody = el("tbody");
  albumTable.append(albumThead, albumTbody);
  albumScroll.appendChild(albumTable);
  listsMain.append(albumToolbar, legend, albumScroll);

  const inspector = el("aside", { class: "lists-inspector card" });
  inspector.appendChild(el("h3", { class: "lists-inspector-title" }, tr("Details")));
  const inspectStatus = el("div", { class: "lists-inspector-status", hidden: true });
  const inspectBody = el("div", { class: "lists-inspector-body" });
  inspectBody.appendChild(
    el("p", { class: "lists-empty lists-inspector-hint" }, tr("Tap a row or look up a ref.")),
  );
  const inspectFoot = el("div", { class: "lists-inspector-foot" });
  const deskBtn = el("button", { class: "btn", type: "button", disabled: true }, tr("Open in Desk"));
  let lastInspect: StickerDetail | null = null;
  deskBtn.addEventListener("click", () => {
    if (!lastInspect) return;
    const fn = openDeskLookupFromLists;
    if (fn) void fn(albumStickerRefLabel(lastInspect));
  });
  inspectFoot.appendChild(deskBtn);
  inspector.append(inspectStatus, inspectBody, inspectFoot);

  const layout = el("div", { class: "lists-layout" });
  layout.append(listsMain, inspector);
  section.appendChild(layout);

  let albumRows: StickerDetail[] = [];

  function albumSearchMatchesRow(d: StickerDetail, raw: string): boolean {
    const t = raw.trim();
    if (!t) return true;
    try {
      const expanded = expandRefsFromLine(t);
      if (expanded.length === 1) {
        return canonicalRef(d.ref) === canonicalRef(expanded[0]!);
      }
    } catch {
      /* not a single parseable ref line — substring filter below */
    }
    const ql = t.toLowerCase();
    const grp = typeof d.album_index_group === "string" && d.album_index_group.trim() ? d.album_index_group.trim() : "";
    const pageStr =
      typeof d.album_printed_page === "number" && d.album_printed_page >= 0 ? String(d.album_printed_page) : "";
    const hay = [
      d.ref,
      albumStickerRefLabel(d),
      stickerTypeShortLabel(d.category_code, d.role),
      formatLookupStatusLabel(d.status),
      grp,
      pageStr,
      albumPasteLineForDetail(d),
      d.category_code,
      d.slot_code,
    ]
      .join(" ")
      .toLowerCase();
    return hay.includes(ql);
  }

  function albumRowPassesFilters(d: StickerDetail): boolean {
    const tf = typeFilter.value;
    if (tf !== "all" && stickerTypeShortLabel(d.category_code, d.role) !== tf) return false;
    const sf = statusFilter.value;
    if (sf !== "all" && d.status !== sf) return false;
    return albumSearchMatchesRow(d, searchInput.value);
  }

  function buildAlbumRow(d: StickerDetail): HTMLTableRowElement {
    const row = el("tr", { class: "lists-album-row", tabindex: "0", role: "button" });
    row.addEventListener("click", () => showInspectorDetail(d));
    const refShown = albumStickerRefLabel(d);
    const tdRef = el("td", { class: "lists-album-td-ref" });
    tdRef.appendChild(el("span", { class: listStickerRoleRefClass(d.role) }, refShown));
    row.appendChild(tdRef);
    row.appendChild(el("td", { class: "ref" }, tr(stickerTypeShortLabel(d.category_code, d.role))));
    const g =
      typeof d.album_index_group === "string" && d.album_index_group.trim().length > 0 ? d.album_index_group : "—";
    row.appendChild(el("td", { class: "ref" }, g));
    const pageStr =
      typeof d.album_printed_page === "number" && d.album_printed_page >= 0 ? String(d.album_printed_page) : "—";
    row.appendChild(el("td", { class: "ref" }, pageStr));
    const tdSt = el("td", { class: "lists-album-td-status" });
    tdSt.appendChild(el("span", { class: lookupStatusBadgeClass(d.status) }, formatLookupStatusLabel(d.status)));
    row.appendChild(tdSt);
    row.appendChild(el("td", { class: "ref" }, String(d.qty)));
    row.appendChild(el("td", { class: "ref" }, String(d.spare_copies)));
    return row;
  }

  function renderAlbumTable(): void {
    albumTbody.replaceChildren();
    const visible = albumRows.filter(albumRowPassesFilters);
    if (visible.length === 0) {
      albumTbody.appendChild(
        el(
          "tr",
          {},
          el(
            "td",
            { colspan: "7", class: "lists-album-empty" },
            albumRows.length === 0 ? "Loading or no data." : "No rows match filters or search.",
          ),
        ),
      );
      return;
    }
    for (const d of visible) {
      albumTbody.appendChild(buildAlbumRow(d));
    }
  }

  typeFilter.addEventListener("change", () => renderAlbumTable());
  statusFilter.addEventListener("change", () => renderAlbumTable());

  function showInspectorDetail(d: StickerDetail): void {
    lastInspect = d;
    inspectStatus.replaceChildren();
    inspectStatus.hidden = true;
    inspectBody.replaceChildren(renderLookupResult(d));
    deskBtn.disabled = false;
  }

  async function runStickerCheck(raw: string): Promise<void> {
    inspectStatus.replaceChildren();
    inspectStatus.hidden = true;
    try {
      const expanded = expandRefsFromLine(raw.trim());
      if (expanded.length === 0) {
        inspectStatus.hidden = false;
        inspectStatus.appendChild(el("div", { class: "msg-error" }, tr("Enter a sticker ref.")));
        return;
      }
      if (expanded.length > 1) {
        inspectStatus.hidden = false;
        inspectStatus.appendChild(
          el("div", { class: "msg-error" }, tr("One ref at a time.")),
        );
        return;
      }
      inspectStatus.hidden = false;
      inspectStatus.appendChild(el("p", { class: "lists-empty" }, tr("Loading…")));
      const ref = expanded[0]!;
      const detail = await getStickerByRef(ref);
      showInspectorDetail(detail);
    } catch (e) {
      inspectBody.replaceChildren();
      inspectStatus.replaceChildren(errBox(e));
      inspectStatus.hidden = false;
      deskBtn.disabled = true;
      lastInspect = null;
    }
  }

  searchInput.addEventListener("input", () => renderAlbumTable());
  searchGo.addEventListener("click", () => void runStickerCheck(searchInput.value));
  searchInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void runStickerCheck(searchInput.value);
    }
  });

  async function load(): Promise<void> {
    albumTbody.replaceChildren(
      el(
        "tr",
        {},
        el("td", { colspan: "7", class: "lists-album-empty" }, tr("Loading album…")),
      ),
    );
    try {
      albumRows = await getAlbumTable();
      const n = albumRows.filter((r) => r.status === "missing").length;
      const d = albumRows.filter((r) => r.status === "duplicate").length;
      lead.textContent =
        n === 0 && d === 0 ? "All slots filled once · no spare stacks." : `${n} missing · ${d} with spares.`;
      renderAlbumTable();
    } catch (e) {
      albumRows = [];
      albumTbody.replaceChildren(el("tr", {}, el("td", { colspan: "7" }, errBox(e))));
      lead.textContent = "Could not load table.";
    }
  }

  loadBtn.addEventListener("click", () => void load());
  load();
  return section;
}

function buildDesk(): HTMLElement {
  const section = el("section", { class: "view", id: "view-desk" });
  views.desk = section;
  section.appendChild(el("h2", {}, tr("Add stickers")));
  section.appendChild(
    el(
      "p",
      { class: "muted desk-intro", style: "margin:0 0 1rem;font-size:0.95rem;line-height:1.5;max-width:52rem" },
      tr(
        "Paste sticker refs below, Preview to see new vs duplicate, then Add to album. Optional: count toward packs opened when you opened physical packs. Ref format: MEX:5, 00, FWC 14, MEX: 1, 2, 3, MEX:5 x3.",
      ),
    ),
  );

  const { addRoot, clearAddDrafts } = buildAddStickersPanel();
  section.appendChild(addRoot);

  const { validateRoot, clearValidateDrafts } = buildValidateListPanel();

  const lookupCard = el("div", { class: "card" });
  const refInput = el("input", {
    type: "text",
    placeholder: tr("MEX:5 · 00 · FWC 14 · MEX: 1, 2, 3"),
    "data-sticker-draft": "1",
  }) as HTMLInputElement;
  const lookupResultHost = el("div", { class: "lookup-result-host" });
  const lookupErr = el("div", { class: "lookup-errors" });
  lookupCard.appendChild(el("h3", {}, tr("Lookup")));
  lookupCard.appendChild(el("label", { class: "field" }, tr("Sticker ref")));
  lookupCard.appendChild(refInput);
  attachStickerRefAutocomplete(refInput);
  const lookupBtn = el("button", { class: "btn btn-primary", type: "button" }, tr("Look up"));
  async function runLookup(): Promise<void> {
    lookupResultHost.replaceChildren();
    lookupErr.replaceChildren();
    try {
      const expanded = expandRefsFromLine(refInput.value.trim());
      if (expanded.length === 0) {
        lookupErr.appendChild(el("div", { class: "msg-error" }, tr("Enter a sticker ref.")));
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

  const remCard = el("div", { class: "card" });
  remCard.appendChild(el("h3", {}, tr("Remove stickers")));
  const batchRem = el("textarea", { placeholder: tr("Same format as add"), "data-sticker-draft": "1" }) as HTMLTextAreaElement;
  const batchRemWrap = wrapFieldWithCopyButton(batchRem);
  const remMsg = el("div");
  const applyRem = el("button", { class: "btn btn-primary", type: "button" }, tr("Apply removes"));
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
  remCard.appendChild(el("label", { class: "field" }, tr("Batch")));
  attachStickerRefAutocomplete(batchRem);
  remCard.appendChild(batchRemWrap);
  remCard.appendChild(applyRem);
  remCard.appendChild(remMsg);

  const singleCard = el("div", { class: "card" });
  singleCard.appendChild(el("h3", {}, tr("Single add / remove")));
  const sRef = el("input", { type: "text", placeholder: tr("MEX:5"), "data-sticker-draft": "1" }) as HTMLInputElement;
  const sCount = el("input", { type: "number", min: "1", value: "1" }) as HTMLInputElement;
  const singleMsg = el("div");
  singleCard.appendChild(el("div", { class: "row" }));
  singleCard.querySelector(".row")!.appendChild(el("div", {}, el("label", { class: "field" }, tr("Ref")), sRef));
  singleCard.querySelector(".row")!.appendChild(el("div", {}, el("label", { class: "field" }, tr("Count")), sCount));
  attachStickerRefAutocomplete(sRef);
  const bAdd = el("button", { class: "btn", type: "button" }, tr("Add"));
  const bRem = el("button", { class: "btn", type: "button" }, tr("Remove"));
  bAdd.addEventListener("click", async () => {
    singleMsg.innerHTML = "";
    try {
      await addSticker(sRef.value.trim(), parseInt(sCount.value, 10) || 1);
      singleMsg.appendChild(el("div", { class: "msg-ok" }, tr("OK")));
    } catch (e) {
      singleMsg.appendChild(errBox(e));
    }
  });
  bRem.addEventListener("click", async () => {
    singleMsg.innerHTML = "";
    try {
      await removeSticker(sRef.value.trim(), parseInt(sCount.value, 10) || 1);
      singleMsg.appendChild(el("div", { class: "msg-ok" }, tr("OK")));
    } catch (e) {
      singleMsg.appendChild(errBox(e));
    }
  });
  singleCard.appendChild(el("div", { class: "row" }, bAdd, bRem));
  singleCard.appendChild(singleMsg);

  section.addEventListener(PANINI_CLEAR_STICKER_DRAFTS, () => {
    clearAddDrafts();
    clearValidateDrafts();
    lookupResultHost.replaceChildren();
    lookupErr.replaceChildren();
    remMsg.replaceChildren();
    singleMsg.replaceChildren();
  });

  openDeskLookupFromLists = async (ref: string) => {
    refInput.value = ref.trim();
    showView("desk");
    refInput.focus();
    lookupCard.scrollIntoView({ behavior: "smooth", block: "nearest" });
    await runLookup();
  };

  section.append(lookupCard, remCard, singleCard, validateRoot);
  return section;
}

function packStickerListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Flatten batch textarea (supports `REF x3`) into one ref per sticker for check/open. */
function parseAddStickerInput(text: string): string[] {
  const rows = parseBatchStickerLines(text);
  const out: string[] = [];
  for (const { ref, count } of rows) {
    stickerPathFromRef(ref);
    const c = canonicalRef(ref);
    for (let i = 0; i < count; i++) out.push(c);
  }
  return out;
}

/** Preview then add stickers; optional pack session + undo when counting as packs. */
function buildAddStickersPanel(): { addRoot: HTMLElement; clearAddDrafts: () => void } {
  const addRoot = el("div", { class: "desk-pack-host" });
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", { style: "margin-top:0" }, tr("Add stickers")));
  card.appendChild(
    el(
      "p",
      { class: "muted", style: "margin:0 0 0.75rem;font-size:0.9rem;line-height:1.45" },
      tr(
        "Preview shows new album slots vs spares (by printed page). Add only when it looks right. Undo is available after a pack-style add until you edit this list.",
      ),
    ),
  );

  const ta = el("textarea", {
    placeholder: `MEX:5\n00\nFWC 14\nMEX: 1, 2, 3\nMEX:5 x3`,
    "data-sticker-draft": "1",
  }) as HTMLTextAreaElement;
  const taWrap = wrapFieldWithCopyButton(ta);

  const countAsPackId = "add-count-as-pack";
  const countAsPackCb = el("input", { type: "checkbox", id: countAsPackId, checked: true }) as HTMLInputElement;

  const editNominalId = "pack-edit-nominal";
  const perPack = el("input", {
    type: "number",
    min: "1",
    max: "50",
    value: String(STICKERS_PER_PACK),
    readOnly: true,
    "aria-label": "Nominal stickers per pack for packs_opened rounding",
  }) as HTMLInputElement;
  const editNominalCb = el("input", { type: "checkbox", id: editNominalId }) as HTMLInputElement;

  const nominalRow = el("div", {
    class: "row",
    style: "flex-wrap:wrap;align-items:center;gap:0.65rem;margin-bottom:0.5rem",
  });
  nominalRow.appendChild(
    el("span", { class: "ref", style: "font-size:0.85rem" }, `Album standard: ${STICKERS_PER_PACK} / pack`),
  );
  nominalRow.appendChild(perPack);
  nominalRow.appendChild(editNominalCb);
  nominalRow.appendChild(el("label", { for: editNominalId, style: "font-size:0.9rem" }, tr("Allow editing nominal size")));

  type PackValidated = { stickers: string[]; perPack: number; countAsPack: boolean; check: PackCheckResponse };
  let lastValidated: PackValidated | null = null;
  let pendingUndo: { stickers: string[]; packs_opened_delta: number } | null = null;

  const staleHint = el("p", {
    class: "muted",
    hidden: true,
    style: "margin:0.35rem 0 0;font-size:0.82rem",
  });
  staleHint.textContent = tr("List changed — run Preview again before adding.");

  const previewHost = el("div", { class: "pack-preview-host" });
  const checkBtn = el("button", { class: "btn", type: "button" }, tr("Preview"));
  const regBtn = el("button", { class: "btn btn-primary", type: "button", disabled: true }, tr("Add to album"));
  const resultCard = el("div", { class: "card pack-result-card" });
  resultCard.style.display = "none";

  function getPackPerPack(): number {
    const n = parseInt(perPack.value, 10);
    return Number.isFinite(n) && n >= 1 ? n : STICKERS_PER_PACK;
  }

  function invalidatePackValidation(): void {
    lastValidated = null;
    regBtn.disabled = true;
    staleHint.hidden = true;
  }

  editNominalCb.addEventListener("change", () => {
    perPack.readOnly = !editNominalCb.checked;
    if (!editNominalCb.checked) {
      perPack.value = String(STICKERS_PER_PACK);
      invalidatePackValidation();
    }
  });
  perPack.addEventListener("input", () => invalidatePackValidation());
  countAsPackCb.addEventListener("change", () => {
    nominalRow.style.display = countAsPackCb.checked ? "" : "none";
    invalidatePackValidation();
  });
  nominalRow.style.display = "";

  type PackPreviewLine = StickerActionLine;

  function buildOrderedPackPreviewLines(stickers: string[], check: PackCheckResponse): PackPreviewLine[] {
    const newByRef = new Map(check.new_to_album.map((r) => [canonicalRef(r.ref), r]));
    const dupByRef = new Map(check.would_duplicate.map((r) => [canonicalRef(r.ref), r]));
    const sim = new Map<string, number>();
    const lines: PackPreviewLine[] = [];
    for (const raw of stickers) {
      const c = canonicalRef(raw);
      if (!sim.has(c)) {
        const neu = newByRef.get(c);
        const dup = dupByRef.get(c);
        sim.set(c, neu ? neu.qty_before : dup ? dup.qty_before : 0);
      }
      const before = sim.get(c)!;
      const isNew = before === 0;
      const meta = newByRef.get(c) ?? dupByRef.get(c);
      lines.push({
        ref: c,
        isNew,
        page: meta?.album_printed_page ?? -1,
        group: meta?.album_index_group ?? null,
        category_code: meta?.category_code ?? c.split(":")[0] ?? "",
      });
      sim.set(c, before + 1);
    }
    return lines;
  }

  function countPackPreviewActions(lines: PackPreviewLine[]): { newCount: number; spareCount: number } {
    return countStickerActionLines(lines);
  }

  function formatPackPreviewCountsText(
    c: PackCheckResponse,
    lines: PackPreviewLine[],
    countAsPack: boolean,
  ): string {
    const { newCount, spareCount } = countPackPreviewActions(lines);
    if (countAsPack) {
      return trf(
        "{total} sticker(s): {newCount} new to album · {spareCount} spares. Session packs_opened += {packDelta} (nominal {perPack}/pack, rounded).",
        {
          total: String(c.sticker_count),
          newCount: String(newCount),
          spareCount: String(spareCount),
          packDelta: String(c.packs_opened_delta),
          perPack: String(c.per_pack),
        },
      );
    }
    return trf("{total} sticker(s): {newCount} new to album · {spareCount} spares. Packs opened not updated.", {
      total: String(c.sticker_count),
      newCount: String(newCount),
      spareCount: String(spareCount),
    });
  }

  function appendPackCheckColumn(
    title: string,
    rows: PackCheckRow[],
    emptyMsg: string,
    colMod: string,
    asNew: boolean,
  ): HTMLElement {
    const lines: StickerActionLine[] = rows.map((r) => ({
      ref: r.ref,
      isNew: asNew,
      page: r.album_printed_page,
      group: r.album_index_group,
      category_code: r.category_code,
      qtyBefore: r.qty_before,
    }));
    return appendStickerSummaryColumn(
      title,
      lines,
      emptyMsg,
      colMod,
      asNew ? formatStickerRowNewSlot : formatStickerRowDupSlot,
    );
  }

  function renderPackCheckPreviewOrdered(stickers: string[], c: PackCheckResponse, countAsPack: boolean): void {
    previewHost.replaceChildren();
    for (const w of c.warnings) {
      previewHost.appendChild(el("div", { class: "banner-info" }, w));
    }
    if (c.in_pack_duplicates.length > 0) {
      const parts = c.in_pack_duplicates.map((d) => `${d.ref} ×${d.occurrences}`);
      previewHost.appendChild(
        el("div", { class: "banner-info" }, `Repeated lines in this list (each line adds one copy): ${parts.join(", ")}.`),
      );
    }
    const lines = buildOrderedPackPreviewLines(stickers, c);
    previewHost.appendChild(
      el(
        "p",
        { class: "muted pack-preview-counts", style: "margin:0.5rem 0;font-size:0.9rem" },
        formatPackPreviewCountsText(c, lines, countAsPack),
      ),
    );
    previewHost.appendChild(renderStickerOrderedList(lines, tr("In paste order:")));
  }

  function renderPackCheckSummaryGrid(host: HTMLElement, c: PackCheckResponse, lines: PackPreviewLine[]): void {
    host.appendChild(
      el(
        "p",
        { class: "muted pack-preview-counts", style: "margin:0 0 0.65rem;font-size:0.9rem" },
        formatPackPreviewCountsText(c, lines, countAsPackCb.checked),
      ),
    );
    const grid = el("div", { class: "trade-result-grid" });
    grid.appendChild(
      appendPackCheckColumn(
        tr("Goes to album (empty slot)"),
        c.new_to_album,
        tr("None — every line is already in the album at least once."),
        "trade-result-col--in",
        true,
      ),
    );
    grid.appendChild(
      appendPackCheckColumn(
        tr("Adds spare / duplicate"),
        c.would_duplicate,
        tr("None — every line fills a missing slot."),
        "trade-result-col--out",
        false,
      ),
    );
    host.appendChild(grid);
  }

  ta.addEventListener("input", () => {
    invalidatePackValidation();
    if (previewHost.childNodes.length > 0) staleHint.hidden = false;
  });

  checkBtn.addEventListener("click", async () => {
    previewHost.replaceChildren();
    staleHint.hidden = true;
    try {
      const stickers = parseAddStickerInput(ta.value);
      const countAsPack = countAsPackCb.checked;
      const pp = countAsPack ? getPackPerPack() : STICKERS_PER_PACK;
      const c = await checkPack(stickers, pp);
      lastValidated = { stickers, perPack: pp, countAsPack, check: c };
      renderPackCheckPreviewOrdered(stickers, c, countAsPack);
      regBtn.disabled = false;
    } catch (e) {
      lastValidated = null;
      regBtn.disabled = true;
      previewHost.replaceChildren(errBox(e));
    }
  });

  regBtn.addEventListener("click", async () => {
    let stickers: string[];
    try {
      stickers = parseAddStickerInput(ta.value);
    } catch (e) {
      resultCard.style.display = "block";
      resultCard.replaceChildren(errBox(e));
      return;
    }
    const countAsPack = countAsPackCb.checked;
    const pp = countAsPack ? getPackPerPack() : STICKERS_PER_PACK;
    if (
      !lastValidated ||
      !packStickerListsEqual(stickers, lastValidated.stickers) ||
      pp !== lastValidated.perPack ||
      countAsPack !== lastValidated.countAsPack
    ) {
      resultCard.style.display = "block";
      resultCard.replaceChildren(
        el("div", { class: "msg-error" }, tr("Run Preview again — the list no longer matches the preview.")),
      );
      regBtn.disabled = true;
      return;
    }
    const appliedCheck = lastValidated.check;
    const appliedLines = buildOrderedPackPreviewLines(stickers, appliedCheck);
    try {
      if (countAsPack) {
        const r = await openPack(stickers, pp);
        pendingUndo = { stickers: [...stickers], packs_opened_delta: r.packs_opened_delta };
        ta.value = "";
        invalidatePackValidation();
        previewHost.replaceChildren();
        staleHint.hidden = true;

        resultCard.style.display = "block";
        resultCard.replaceChildren();
        resultCard.appendChild(el("h3", {}, tr("Stickers added")));
        for (const w of r.warnings) {
          resultCard.appendChild(el("div", { class: "banner-info" }, w));
        }
        if (r.in_pack_duplicates.length > 0) {
          const parts = r.in_pack_duplicates.map((d) => `${d.ref} ×${d.occurrences}`);
          resultCard.appendChild(el("div", { class: "banner-info" }, `In-pack repeats: ${parts.join(", ")}.`));
        }
        renderPackCheckSummaryGrid(resultCard, appliedCheck, appliedLines);
        const undoRow = el("div", { class: "trade-result-actions" });
        const undoBtn = el("button", { class: "btn", type: "button" }, tr("Undo this add"));
        undoBtn.addEventListener("click", async () => {
          if (!pendingUndo) return;
          undoBtn.disabled = true;
          try {
            await undoPackOpen(pendingUndo.stickers, pendingUndo.packs_opened_delta);
            pendingUndo = null;
            resultCard.replaceChildren();
            resultCard.appendChild(el("h3", {}, tr("Add undone")));
            resultCard.appendChild(
              el("p", { class: "muted" }, tr("Inventory and packs_opened were restored. Paste the list again if you still want to add it.")),
            );
            void overviewPage.reload();
            void loadTradePreviewData();
          } catch (e) {
            undoBtn.disabled = false;
            resultCard.appendChild(errBox(e));
          }
        });
        undoRow.appendChild(undoBtn);
        resultCard.appendChild(undoRow);
      } else {
        const rows = parseBatchStickerLines(ta.value);
        for (const { ref, count } of rows) {
          await addSticker(ref, count);
        }
        ta.value = "";
        invalidatePackValidation();
        previewHost.replaceChildren();
        staleHint.hidden = true;
        pendingUndo = null;

        resultCard.style.display = "block";
        resultCard.replaceChildren();
        resultCard.appendChild(el("h3", {}, tr("Stickers added")));
        renderPackCheckSummaryGrid(resultCard, appliedCheck, appliedLines);
      }
      void overviewPage.reload();
      void loadTradePreviewData();
    } catch (e) {
      resultCard.style.display = "block";
      resultCard.replaceChildren(errBox(e));
    }
  });

  const btnRow = el("div", { class: "row", style: "gap:0.5rem;flex-wrap:wrap;margin:0.5rem 0" });
  btnRow.append(checkBtn, regBtn);

  const countRow = el("div", {
    class: "row",
    style: "flex-wrap:wrap;align-items:center;gap:0.5rem;margin-bottom:0.5rem",
  });
  countRow.appendChild(countAsPackCb);
  countRow.appendChild(el("label", { for: countAsPackId, style: "font-size:0.9rem" }, tr("Count toward packs opened")));

  card.appendChild(el("label", { class: "field" }, tr("Sticker refs")));
  attachStickerRefAutocomplete(ta);
  card.appendChild(taWrap);
  card.appendChild(countRow);
  card.appendChild(nominalRow);
  card.appendChild(btnRow);
  card.appendChild(staleHint);
  card.appendChild(previewHost);

  addRoot.append(card, resultCard);

  function clearAddDrafts(): void {
    invalidatePackValidation();
    previewHost.replaceChildren();
    staleHint.hidden = true;
    resultCard.style.display = "none";
    resultCard.replaceChildren();
    pendingUndo = null;
  }

  return { addRoot, clearAddDrafts };
}

type ValidateListEntry = {
  ref: string;
  listCount: number;
  detail: StickerDetail;
};

type ValidateListSort = "album" | "alpha";

function hintsFromAlbumDetails(rows: StickerDetail[]): Map<string, AlbumOrderHint> {
  const m = new Map<string, AlbumOrderHint>();
  for (const r of rows) {
    m.set(canonicalRef(r.ref), {
      category_code: r.category_code,
      slot_code: r.slot_code,
      album_printed_page: r.album_printed_page,
    });
  }
  return m;
}

function sortValidateEntries(
  entries: ValidateListEntry[],
  mode: ValidateListSort,
  hints: Map<string, AlbumOrderHint>,
): ValidateListEntry[] {
  const cmp =
    mode === "album"
      ? (a: ValidateListEntry, b: ValidateListEntry) => compareRefsByAlbumOrder(a.ref, b.ref, hints)
      : (a: ValidateListEntry, b: ValidateListEntry) => compareRefsAlphabetically(a.ref, b.ref);
  return [...entries].sort(cmp);
}

function validateListCopyLines(entries: ValidateListEntry[], mode: ValidateListSort, hints: Map<string, AlbumOrderHint>): string[] {
  const sorted = sortValidateEntries(entries, mode, hints);
  const lines: string[] = [];
  for (const e of sorted) {
    const label = albumStickerRefLabel(e.detail);
    for (let i = 0; i < e.listCount; i++) lines.push(label);
  }
  return lines;
}

function validateListReportLines(entries: ValidateListEntry[], mode: ValidateListSort, hints: Map<string, AlbumOrderHint>): string[] {
  const sorted = sortValidateEntries(entries, mode, hints);
  return sorted.map((e) => {
    const label = albumStickerRefLabel(e.detail);
    const status = formatLookupStatusLabel(e.detail.status);
    const type = stickerTypeShortLabel(e.detail.category_code, e.detail.role);
    const page =
      typeof e.detail.album_printed_page === "number" && e.detail.album_printed_page >= 0
        ? String(e.detail.album_printed_page)
        : "—";
    const grp =
      typeof e.detail.album_index_group === "string" && e.detail.album_index_group.trim()
        ? e.detail.album_index_group.trim()
        : "";
    const grpPart = grp ? ` · ${tr("Group")} ${grp}` : "";
    const inList = e.listCount > 1 ? ` · ×${e.listCount} ${tr("in list")}` : "";
    return `${label} · ${status} · ${type} · ${tr("Page")} ${page}${grpPart} · ${tr("Qty")} ${e.detail.qty}${inList}`;
  });
}

/** Check a pasted list against the album (status, type, page) without changing inventory. */
function buildValidateListPanel(): { validateRoot: HTMLElement; clearValidateDrafts: () => void } {
  const validateRoot = el("div", { class: "desk-validate-host" });
  const card = el("div", { class: "card" });
  card.appendChild(el("h3", { style: "margin-top:0" }, tr("Validate list")));
  card.appendChild(
    el(
      "p",
      { class: "muted", style: "margin:0 0 0.75rem;font-size:0.9rem;line-height:1.45" },
      tr("Paste refs to see how they match your album: missing, in album, or spare. Does not add or remove stickers."),
    ),
  );

  const ta = el("textarea", {
    placeholder: `MEX:5\n00\nMEX: 1, 2, 3\nMEX:5 x2`,
    rows: "6",
    "data-sticker-draft": "1",
  }) as HTMLTextAreaElement;
  const taWrap = wrapFieldWithCopyButton(ta);
  attachStickerRefAutocomplete(ta);

  const sortAlbumId = "validate-sort-album";
  const sortAlphaId = "validate-sort-alpha";
  const sortAlbumRb = el("input", { type: "radio", name: "validate-sort", id: sortAlbumId, checked: true }) as HTMLInputElement;
  const sortAlphaRb = el("input", { type: "radio", name: "validate-sort", id: sortAlphaId }) as HTMLInputElement;

  const sortRow = el("div", { class: "validate-sort-row row", style: "flex-wrap:wrap;gap:0.75rem;align-items:center;margin:0.5rem 0" });
  sortRow.appendChild(el("span", { class: "muted", style: "font-size:0.85rem" }, tr("Sort:")));
  sortRow.appendChild(sortAlbumRb);
  sortRow.appendChild(el("label", { for: sortAlbumId, style: "font-size:0.9rem" }, tr("Album order")));
  sortRow.appendChild(sortAlphaRb);
  sortRow.appendChild(el("label", { for: sortAlphaId, style: "font-size:0.9rem" }, tr("A–Z")));

  const summaryHost = el("div", { class: "validate-summary-host" });
  const errHost = el("div");
  const tableHost = el("div", { class: "validate-table-scroll" });
  const actionsRow = el("div", { class: "row validate-actions-row", style: "flex-wrap:wrap;gap:0.5rem;margin-top:0.5rem" });
  const copyRefsBtn = el("button", { class: "btn", type: "button", disabled: true }, tr("Copy refs (sorted)"));
  const copyReportBtn = el("button", { class: "btn", type: "button", disabled: true }, tr("Copy report (sorted)"));
  actionsRow.append(copyRefsBtn, copyReportBtn);

  let lastEntries: ValidateListEntry[] | null = null;
  let lastHints: Map<string, AlbumOrderHint> = new Map();
  let lastSort: ValidateListSort = "album";

  function currentSort(): ValidateListSort {
    return sortAlphaRb.checked ? "alpha" : "album";
  }

  function setCopyButtonsEnabled(on: boolean): void {
    copyRefsBtn.disabled = !on;
    copyReportBtn.disabled = !on;
  }

  function renderSummary(entries: ValidateListEntry[], totalInstances: number, parseErrors: string[]): void {
    summaryHost.replaceChildren();
    const unique = entries.length;
    let missing = 0;
    let inAlbum = 0;
    let spare = 0;
    for (const e of entries) {
      if (e.detail.status === "missing") missing += e.listCount;
      else if (e.detail.status === "duplicate") spare += e.listCount;
      else inAlbum += e.listCount;
    }
    const summary = el("div", { class: "validate-summary" });
    summary.appendChild(
      el(
        "p",
        { class: "validate-summary-lede", style: "margin:0 0 0.5rem;font-size:0.95rem" },
        trf("{total} sticker(s) in list · {unique} unique ref(s)", {
          total: String(totalInstances),
          unique: String(unique),
        }),
      ),
    );
    const chips = el("div", { class: "validate-summary-chips row", style: "flex-wrap:wrap;gap:0.4rem" });
    if (missing > 0) {
      chips.appendChild(
        el("span", { class: "lookup-badge lookup-badge--missing" }, trf("{n} missing", { n: String(missing) })),
      );
    }
    if (inAlbum > 0) {
      chips.appendChild(
        el("span", { class: "lookup-badge lookup-badge--ok" }, trf("{n} in album", { n: String(inAlbum) })),
      );
    }
    if (spare > 0) {
      chips.appendChild(
        el("span", { class: "lookup-badge lookup-badge--dup" }, trf("{n} spare", { n: String(spare) })),
      );
    }
    summary.appendChild(chips);
    if (parseErrors.length > 0) {
      summary.appendChild(
        el(
          "p",
          { class: "muted", style: "margin:0.5rem 0 0;font-size:0.82rem" },
          trf("{n} line(s) could not be parsed.", { n: String(parseErrors.length) }),
        ),
      );
    }
    summaryHost.appendChild(summary);
  }

  function renderTable(entries: ValidateListEntry[], mode: ValidateListSort, hints: Map<string, AlbumOrderHint>): void {
    tableHost.replaceChildren();
    if (entries.length === 0) return;
    const sorted = sortValidateEntries(entries, mode, hints);
    const table = el("table", { class: "data validate-list-table" });
    const thead = el("thead");
    const hr = el("tr");
    for (const h of [tr("Ref"), tr("In list"), tr("Status"), tr("Type"), tr("Group"), tr("Page"), tr("Qty"), tr("Spare")]) {
      hr.appendChild(el("th", {}, h));
    }
    thead.appendChild(hr);
    table.appendChild(thead);
    const tbody = el("tbody");
    for (const e of sorted) {
      const trRow = el("tr");
      const label = albumStickerRefLabel(e.detail);
      const tdRef = el("td", { class: "validate-td-ref" });
      tdRef.appendChild(el("span", { class: listStickerRoleRefClass(e.detail.role) }, label));
      trRow.appendChild(tdRef);
      trRow.appendChild(el("td", { class: "ref" }, e.listCount > 1 ? `×${e.listCount}` : "1"));
      const tdSt = el("td");
      tdSt.appendChild(
        el("span", { class: lookupStatusBadgeClass(e.detail.status) }, formatLookupStatusLabel(e.detail.status)),
      );
      trRow.appendChild(tdSt);
      trRow.appendChild(el("td", { class: "ref" }, tr(stickerTypeShortLabel(e.detail.category_code, e.detail.role))));
      const g =
        typeof e.detail.album_index_group === "string" && e.detail.album_index_group.trim()
          ? e.detail.album_index_group.trim()
          : "—";
      trRow.appendChild(el("td", { class: "ref" }, g));
      const pageStr =
        typeof e.detail.album_printed_page === "number" && e.detail.album_printed_page >= 0
          ? String(e.detail.album_printed_page)
          : "—";
      trRow.appendChild(el("td", { class: "ref" }, pageStr));
      trRow.appendChild(el("td", { class: "ref" }, String(e.detail.qty)));
      trRow.appendChild(el("td", { class: "ref" }, String(e.detail.spare_copies)));
      tbody.appendChild(trRow);
    }
    table.appendChild(tbody);
    tableHost.appendChild(table);
  }

  function rerenderFromCache(): void {
    if (!lastEntries) return;
    lastSort = currentSort();
    renderTable(lastEntries, lastSort, lastHints);
  }

  sortAlbumRb.addEventListener("change", () => {
    if (sortAlbumRb.checked) rerenderFromCache();
  });
  sortAlphaRb.addEventListener("change", () => {
    if (sortAlphaRb.checked) rerenderFromCache();
  });

  copyRefsBtn.addEventListener("click", async () => {
    if (!lastEntries) return;
    try {
      await copyTextToClipboard(validateListCopyLines(lastEntries, currentSort(), lastHints).join("\n"));
      copyRefsBtn.textContent = tr("Copied!");
      setTimeout(() => {
        copyRefsBtn.textContent = tr("Copy refs (sorted)");
      }, 1500);
    } catch {
      copyRefsBtn.textContent = tr("Copy failed");
    }
  });

  copyReportBtn.addEventListener("click", async () => {
    if (!lastEntries) return;
    try {
      await copyTextToClipboard(validateListReportLines(lastEntries, currentSort(), lastHints).join("\n"));
      copyReportBtn.textContent = tr("Copied!");
      setTimeout(() => {
        copyReportBtn.textContent = tr("Copy report (sorted)");
      }, 1500);
    } catch {
      copyReportBtn.textContent = tr("Copy failed");
    }
  });

  const validateBtn = el("button", { class: "btn btn-primary", type: "button" }, tr("Validate"));
  validateBtn.addEventListener("click", async () => {
    errHost.replaceChildren();
    summaryHost.replaceChildren();
    tableHost.replaceChildren();
    setCopyButtonsEnabled(false);
    lastEntries = null;

    const parseErrors: string[] = [];
    const countByRef = new Map<string, number>();
    try {
      const rows = parseBatchStickerLines(ta.value);
      for (const { ref, count } of rows) {
        stickerPathFromRef(ref);
        const c = canonicalRef(ref);
        countByRef.set(c, (countByRef.get(c) ?? 0) + count);
      }
    } catch (e) {
      parseErrors.push(e instanceof Error ? e.message : String(e));
    }

    if (countByRef.size === 0 && parseErrors.length === 0) {
      errHost.appendChild(el("div", { class: "msg-error" }, tr("Enter at least one sticker ref.")));
      return;
    }

    let albumByCanon: Map<string, StickerDetail>;
    try {
      const album = await getAlbumTable();
      albumByCanon = new Map(album.map((r) => [canonicalRef(r.ref), r]));
      lastHints = hintsFromAlbumDetails(album);
    } catch (e) {
      errHost.appendChild(errBox(e));
      return;
    }

    const entries: ValidateListEntry[] = [];
    for (const [ref, listCount] of countByRef) {
      const detail = albumByCanon.get(ref);
      if (!detail) {
        parseErrors.push(`${ref}: ${tr("Unknown sticker ref.")}`);
        continue;
      }
      entries.push({ ref, listCount, detail });
    }

    const totalInstances = [...countByRef.values()].reduce((a, b) => a + b, 0);
    lastEntries = entries;
    lastSort = currentSort();

    if (parseErrors.length > 0) {
      errHost.appendChild(
        el(
          "div",
          { class: "banner-info", style: "font-size:0.82rem;white-space:pre-wrap;margin-bottom:0.5rem" },
          parseErrors.slice(0, 20).join("\n") + (parseErrors.length > 20 ? "\n…" : ""),
        ),
      );
    }

    if (entries.length === 0) {
      errHost.appendChild(el("div", { class: "msg-error" }, tr("No valid refs to show.")));
      return;
    }

    renderSummary(entries, totalInstances, parseErrors);
    renderTable(entries, lastSort, lastHints);
    setCopyButtonsEnabled(true);
  });

  card.appendChild(el("label", { class: "field" }, tr("Sticker refs")));
  card.appendChild(taWrap);
  card.appendChild(validateBtn);
  card.appendChild(sortRow);
  card.appendChild(summaryHost);
  card.appendChild(errHost);
  card.appendChild(tableHost);
  card.appendChild(actionsRow);
  validateRoot.appendChild(card);

  function clearValidateDrafts(): void {
    summaryHost.replaceChildren();
    errHost.replaceChildren();
    tableHost.replaceChildren();
    setCopyButtonsEnabled(false);
    lastEntries = null;
  }

  return { validateRoot, clearValidateDrafts };
}

function formatPreviewRefList(refs: string[], max = 20): string {
  const u = [...new Set(refs)];
  u.sort();
  if (u.length <= max) return u.join(", ");
  return `${u.slice(0, max).join(", ")} (+${u.length - max} more)`;
}

function skipCrosscheckPasteHeaderLine(t: string): boolean {
  const s = t.trim();
  if (s.length < 2) return true;
  if (/^(missing|duplicates)$/i.test(s)) return true;
  if (s.startsWith("===")) return true;
  if (/^progress:/i.test(s)) return true;
  if (/^panini\s+wm26/i.test(s)) return true;
  if (/^generated:/i.test(s)) return true;
  return false;
}

function parseTheirRefPaste(text: string): { refs: string[]; errors: string[] } {
  const refs: string[] = [];
  const errors: string[] = [];
  for (const line of splitInputLines(text)) {
    if (skipCrosscheckPasteHeaderLine(line)) continue;
    try {
      refs.push(...expandRefsFromLine(line));
    } catch (e) {
      errors.push(`${line}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { refs, errors };
}

/** Group canonical refs into `TEAM: n, n, …` lines (FWC slot 20 shown as `00`). */
function formatRefsAsCompactLines(refs: string[]): string {
  const canon = [...new Set(refs.map((r) => canonicalRef(r)))];
  const by = new Map<string, number[]>();
  for (const ref of canon) {
    const i = ref.indexOf(":");
    if (i < 0) continue;
    const cat = ref.slice(0, i);
    const slot = parseInt(ref.slice(i + 1), 10);
    if (Number.isNaN(slot)) continue;
    if (!by.has(cat)) by.set(cat, []);
    by.get(cat)!.push(slot);
  }
  const cats = sortTeamCodes([...by.keys()]);
  const lines: string[] = [];
  for (const cat of cats) {
    const slots = by.get(cat)!.sort((x, y) => x - y);
    const parts = slots.map((n) => (cat === "FWC" && n === 20 ? "00" : String(n)));
    lines.push(`${cat}: ${parts.join(", ")}`);
  }
  return lines.join("\n");
}

const TRADE_PAIR_ORDER = ["fwc", "team_photo", "shield", "player"] as const;
type TradePairBucket = (typeof TRADE_PAIR_ORDER)[number];

/** Fair swap buckets: all FWC together, then team photo, shield, rest as players. */
function tradePairBucket(row: {
  category_code: string;
  role: StickerRole | null | undefined;
}): TradePairBucket {
  if (row.category_code.toUpperCase() === "FWC") return "fwc";
  if (row.role === "team_photo") return "team_photo";
  if (row.role === "shield") return "shield";
  return "player";
}

/** Pair give/take refs in parallel lists, preferring same bucket (FWC↔FWC, team photo↔team photo, …). */
function fairTradePairedLists(
  giveRefs: string[],
  takeRefs: string[],
  dupByCanon: Map<string, ListStickerRow>,
  missingByCanon: Map<string, ListStickerRow>,
): { give: string[]; take: string[]; leftoverGive: string[]; leftoverTake: string[] } {
  const hints = albumHintsFromRows(dupByCanon, missingByCanon);
  const gCanon = sortRefsByAlbumOrder([...new Set(giveRefs.map((r) => canonicalRef(r)))], hints);
  const tCanon = sortRefsByAlbumOrder([...new Set(takeRefs.map((r) => canonicalRef(r)))], hints);

  const giveQueues: Record<TradePairBucket, string[]> = { fwc: [], team_photo: [], shield: [], player: [] };
  const takeQueues: Record<TradePairBucket, string[]> = { fwc: [], team_photo: [], shield: [], player: [] };

  for (const ref of gCanon) {
    const row = dupByCanon.get(ref);
    if (row) giveQueues[tradePairBucket(row)].push(ref);
  }
  for (const ref of tCanon) {
    const row = missingByCanon.get(ref);
    if (row) takeQueues[tradePairBucket(row)].push(ref);
  }

  const pairs: { g: string; t: string }[] = [];
  for (const b of TRADE_PAIR_ORDER) {
    const g = giveQueues[b];
    const t = takeQueues[b];
    const n = Math.min(g.length, t.length);
    for (let i = 0; i < n; i++) {
      pairs.push({ g: g[i]!, t: t[i]! });
    }
  }
  pairs.sort((a, b) => compareRefsByAlbumOrder(a.g, b.g, hints));

  const giveOut = pairs.map((p) => p.g);
  const takeOut = pairs.map((p) => p.t);
  const pairedGive = new Set(giveOut);
  const pairedTake = new Set(takeOut);
  const leftoverGive = gCanon.filter((r) => !pairedGive.has(r));
  const leftoverTake = tCanon.filter((r) => !pairedTake.has(r));
  return { give: giveOut, take: takeOut, leftoverGive, leftoverTake };
}

function buildPackOutlook(): HTMLElement {
  const section = el("section", { class: "view", id: "view-pack-outlook" });
  views["pack-outlook"] = section;
  section.appendChild(el("h2", {}, tr("Album completion estimate")));

  const intro = el("p", {
    class: "muted",
    style: "margin:0 0 1rem;font-size:0.88rem;line-height:1.45;max-width:52rem",
  });
  intro.textContent = tr(
    "Simulates opening more packs from your current album. Each pack adds random stickers from across the full album. Two knobs: how many people you trade with (market reach), and what share of your duplicate copies you successfully swap for missing ones. Each duplicate is one independent try (inventory + new pulls; idealized fair swaps). Rough simulation, not real Panini odds.",
  );
  const introRateNote = el("p", {
    class: "muted pack-outlook-intro-rate",
    style: "margin:-0.5rem 0 1rem;font-size:0.85rem;line-height:1.45;max-width:52rem",
  });

  const rowTop = el("div", { class: "pack-outlook-top", style: "display:flex;flex-wrap:wrap;gap:1.25rem;align-items:flex-start;margin-bottom:1rem" });
  const ringWrap = el("div", { style: "flex:0 0 auto" });
  const ringHost = el("div", { id: "pack-outlook-ring" });
  ringWrap.appendChild(ringHost);

  const controlsWrap = el("div", {
    class: "pack-outlook-controls",
    style: "flex:1 1 18rem;min-width:min(100%,16rem);display:flex;flex-direction:column;gap:1rem",
  });

  const sliderCard = el("div", { class: "card" });
  sliderCard.appendChild(el("h3", { style: "margin-top:0" }, tr("Duplicate trade rate")));
  const sliderRow = el("div", { class: "pack-outlook-slider-row", style: "display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap" });
  const DEFAULT_TRADE_RATE_PCT = 30;
  const range = el("input", {
    type: "range",
    min: "0",
    max: "100",
    value: String(DEFAULT_TRADE_RATE_PCT),
    class: "pack-outlook-range",
    "aria-label": tr(
      "Share of duplicate stickers successfully traded for missing ones you still need",
    ),
  }) as HTMLInputElement;
  const pctLabel = el("span", { class: "ref", style: "min-width:4.5rem" }, `${DEFAULT_TRADE_RATE_PCT}%`);
  sliderRow.appendChild(range);
  sliderRow.appendChild(pctLabel);
  sliderCard.appendChild(sliderRow);
  const tradeRepeatHint = el("p", {
    class: "muted",
    style: "margin:0.5rem 0 0;font-size:0.82rem;line-height:1.45",
  }) as HTMLParagraphElement;
  sliderCard.appendChild(tradeRepeatHint);

  const networkCard = el("div", { class: "card" });
  networkCard.appendChild(el("h3", { style: "margin-top:0" }, tr("Trading network")));
  const networkRow = el("div", { class: "pack-outlook-slider-row", style: "display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap" });
  const partnersRange = el("input", {
    type: "range",
    min: "0",
    max: "20",
    value: "5",
    class: "pack-outlook-range",
    "aria-label": tr("Number of people you regularly trade stickers with"),
  }) as HTMLInputElement;
  const partnersLabel = el("span", { class: "ref", style: "min-width:4.5rem" }, "5");
  networkRow.appendChild(partnersRange);
  networkRow.appendChild(partnersLabel);
  networkCard.appendChild(networkRow);
  const networkHint = el("p", {
    class: "muted",
    style: "margin:0.5rem 0 0;font-size:0.82rem;line-height:1.45",
  }) as HTMLParagraphElement;
  networkCard.appendChild(networkHint);

  function networkReachPct(partners: number): number {
    if (partners <= 0) return 0;
    return Math.round((1 - Math.exp(-partners / 5)) * 100);
  }

  function syncControlHints(): void {
    const v = range.value;
    const partners = Number(partnersRange.value);
    const reach = networkReachPct(partners);
    const eff = Math.round((Number(v) / 100) * (reach / 100) * 100);
    pctLabel.textContent = `${v}%`;
    partnersLabel.textContent = String(partners);
    tradeRepeatHint.textContent = trf(
      "{pct}% of duplicate copies you close when a match exists. {perPack} stickers per pack — same as the Pack tab.",
      { pct: v, perPack: String(STICKERS_PER_PACK) },
    );
    networkHint.textContent = trf(
      "{partners} trading contacts (~{reach}% market reach). Effective conversion ≈ {eff}% per duplicate.",
      { partners: String(partners), reach: String(reach), eff: String(eff) },
    );
  }
  syncControlHints();

  controlsWrap.appendChild(sliderCard);
  controlsWrap.appendChild(networkCard);
  rowTop.appendChild(ringWrap);
  rowTop.appendChild(controlsWrap);
  section.appendChild(intro);
  section.appendChild(introRateNote);
  section.appendChild(rowTop);

  const status = el("p", {
    class: "muted",
    style: "margin:0 0 0.75rem;font-size:0.9rem;line-height:1.45",
  });
  section.appendChild(status);

  const statsCard = el("div", { class: "card" });
  statsCard.appendChild(el("h3", { style: "margin-top:0" }, tr("Estimate from here")));
  const statsBody = el("div", { id: "pack-outlook-stats", style: "font-size:0.95rem;line-height:1.55" });
  statsCard.appendChild(statsBody);
  section.appendChild(statsCard);

  const disc = el("p", {
    class: "muted",
    style: "margin:0.75rem 0 0;font-size:0.8rem;line-height:1.45;max-width:52rem",
    id: "pack-outlook-disclaimer",
  });
  section.appendChild(disc);

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let seq = 0;
  let tradeSliderUserSet = false;

  function syncIntroRateNote(rate: number | null): void {
    if (rate == null) {
      introRateNote.textContent = tr(
        "Your session duplicate trade rate: not available yet (no spares and no duplicates traded out). Slider defaults to 30%.",
      );
      return;
    }
    const pct = Math.round(rate * 100);
    introRateNote.textContent = trf(
      "Your session duplicate trade rate: {pct}% (traded out ÷ traded out + spares still held). Slider defaults to this.",
      { pct: String(pct) },
    );
  }

  async function applySessionTradeRateDefault(): Promise<void> {
    try {
      const m = await getMetrics();
      const rate = m.session.duplicate_trade_rate ?? null;
      syncIntroRateNote(rate);
      if (!tradeSliderUserSet) {
        const pct = rate != null ? Math.round(rate * 100) : DEFAULT_TRADE_RATE_PCT;
        range.value = String(Math.min(100, Math.max(0, pct)));
        syncControlHints();
      }
    } catch {
      syncIntroRateNote(null);
    }
  }

  function packOutlookDisclaimer(complete: boolean): string {
    return complete
      ? tr("Toy uniform-pack model only; real Panini distribution and trading differ.")
      : tr(
          "Toy model: random stickers per pack; duplicate success rate × trading network reach. Not spending or completion advice — ballpark only.",
        );
  }

  function renderFromData(d: PackOutlookResponse): void {
    ringHost.replaceChildren(
      analyticsPctRingFromSlots(
        d.album_unique_slots - d.unique_slots_missing,
        d.album_unique_slots,
        tr("unique stickers"),
      ),
    );
    const miss = d.unique_slots_missing;
    if (miss <= 0) {
      statsBody.replaceChildren(
        el("p", { style: "margin:0" }, tr("Album complete on unique stickers — no more packs needed in this model.")),
        el(
          "p",
          { class: "muted", style: "margin:0.5rem 0 0;font-size:0.88rem" },
          trf("Session packs opened: {packs}. Spare copies in inventory: {spares}.", {
            packs: String(d.session_packs_opened),
            spares: String(d.spare_copies),
          }),
        ),
      );
      disc.textContent = packOutlookDisclaimer(true);
      return;
    }
    const p50 = d.p50_packs;
    const p90 = d.p90_packs;
    const meanP = d.mean_packs;
    const band =
      p90 > p50
        ? trf("Typical spread: about {p50}–{p90} packs (50th–90th percentile).", {
            p50: String(p50),
            p90: String(p90),
          })
        : trf("50th percentile ≈ {p50} packs; 90th ≈ {p90} packs.", {
            p50: String(p50),
            p90: String(p90),
          });
    const mid = el(
      "p",
      { style: "margin:0.65rem 0 0" },
      trf(
        "From here, median ≈ {p50} more packs (~{stickers} pulls), mean ≈ {mean} packs. {band}",
        {
          p50: String(p50),
          stickers: String(d.p50_stickers),
          mean: String(meanP),
          band,
        },
      ),
    );
    const tail = el(
      "p",
      { class: "muted", style: "margin:0.55rem 0 0;font-size:0.88rem" },
      trf(
        "Session packs opened: {n} — simulation starts from your current gaps, not from replaying past opens.",
        { n: String(d.session_packs_opened) },
      ),
    );
    const warn = d.truncated_note
      ? el("p", { class: "msg-error", style: "margin:0.55rem 0 0;font-size:0.88rem" }, trApiNote(d.truncated_note))
      : null;
    const filled = d.album_unique_slots - miss;
    const { labelPct } = albumProgressDisplay(filled, d.album_unique_slots);
    statsBody.replaceChildren(
      el(
        "p",
        { style: "margin:0" },
        trf("You have {pct}% of unique stickers ({filled} / {total}). Still missing {miss}.", {
          pct: String(labelPct),
          filled: String(filled),
          total: String(d.album_unique_slots),
          miss: String(miss),
        }),
      ),
      mid,
      tail,
      ...(warn ? [warn] : []),
    );
    disc.textContent = packOutlookDisclaimer(false);
  }

  async function loadProjection(): Promise<void> {
    const mySeq = ++seq;
    const tradeP = Number(range.value) / 100;
    const partners = Number(partnersRange.value);
    syncControlHints();
    status.textContent = tr("Running simulation…");
    statsBody.replaceChildren();
    try {
      const d = await getPackOutlook(tradeP, { tradingPartners: partners, perPack: STICKERS_PER_PACK });
      if (mySeq !== seq) return;
      const detail =
        d.trade_repeat_p === 0 || d.trading_partners === 0
          ? tr("packs only")
          : trf("{pct}% duplicate success × {partners} contacts (~{reach}% reach)", {
              pct: String(Math.round(d.trade_repeat_p * 100)),
              partners: String(d.trading_partners),
              reach: String(Math.round(d.network_reach * 100)),
            });
      status.textContent =
        d.trials_used > 0
          ? trf("Based on {trials} simulations ({detail}).", {
              trials: String(d.trials_used),
              detail,
            })
          : tr("Album already complete on unique stickers.");
      renderFromData(d);
    } catch (e) {
      if (mySeq !== seq) return;
      status.textContent = "";
      ringHost.replaceChildren();
      statsBody.replaceChildren(
        el("div", { class: "msg-error" }, e instanceof Error ? e.message : String(e)),
      );
      disc.textContent = "";
    }
  }

  function scheduleLoad(): void {
    if (debounceTimer !== null) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      void loadProjection();
    }, 320);
  }

  range.addEventListener("input", () => {
    tradeSliderUserSet = true;
    syncControlHints();
    scheduleLoad();
  });

  partnersRange.addEventListener("input", () => {
    syncControlHints();
    scheduleLoad();
  });

  packOutlookPage.reload = async () => {
    tradeSliderUserSet = false;
    await applySessionTradeRateDefault();
    await loadProjection();
  };

  void packOutlookPage.reload();
  return section;
}

function buildCrosscheck(): HTMLElement {
  const section = el("section", { class: "view", id: "view-crosscheck" });
  views.crosscheck = section;
  section.appendChild(el("h2", {}, tr("Crosscheck")));

  let missingSet: Set<string> | null = null;
  let dupGiveSet: Set<string> | null = null;
  const missingByCanon = new Map<string, ListStickerRow>();
  const dupByCanon = new Map<string, ListStickerRow>();

  let lastNeedHits: string[] | null = null;
  let lastGiveHits: string[] | null = null;
  let needCompared = false;
  let giveCompared = false;

  const status = el("p", {
    class: "muted",
    style: "margin:0 0 0.75rem;font-size:0.9rem;line-height:1.45",
  });

  async function loadCrosscheckLists(): Promise<void> {
    try {
      const [missing, dups] = await Promise.all([getMissingList(), getDuplicatesList()]);
      missingByCanon.clear();
      dupByCanon.clear();
      for (const r of missing) missingByCanon.set(canonicalRef(r.ref), r);
      for (const r of dups) {
        if ((r.spare_copies ?? Math.max(0, r.qty - 1)) >= 1) {
          dupByCanon.set(canonicalRef(r.ref), r);
        }
      }
      missingSet = new Set(missingByCanon.keys());
      dupGiveSet = new Set(dupByCanon.keys());
      needCompared = false;
      giveCompared = false;
      lastNeedHits = null;
      lastGiveHits = null;
      syncTradeJumpButtons();
      status.textContent = `Using your album: ${missingSet.size} missing slots · ${dupGiveSet.size} refs with at least one spare to trade.`;
    } catch (e) {
      missingSet = null;
      dupGiveSet = null;
      missingByCanon.clear();
      dupByCanon.clear();
      needCompared = false;
      giveCompared = false;
      lastNeedHits = null;
      lastGiveHits = null;
      syncTradeJumpButtons();
      status.textContent = `Could not load missing/duplicate lists: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  crosscheckPage.reload = loadCrosscheckLists;

  const intro = el("p", {
    class: "muted",
    style: "margin:0 0 1rem;font-size:0.88rem;line-height:1.45",
  });
  intro.textContent =
    "Paste a friend’s list in the same ref formats as Desk (including compact lines like MEX: 1, 5, 13). Lines that look like export headers (Missing, Progress:, etc.) are skipped. Lines that fail to parse are listed below the result but other lines still count.";

  const cardNeed = el("div", { class: "card" });
  cardNeed.appendChild(el("h3", {}, tr("Their haves / duplicates → what I need")));
  cardNeed.appendChild(
    el(
      "p",
      { class: "muted", style: "margin:0 0 0.65rem;font-size:0.85rem" },
      "Stickers they say they have (or can trade) that still appear on your missing list.",
    ),
  );
  const taNeed = el("textarea", {
    placeholder: tr("Their list: one ref per line, MEX: 1, 2, 3, or a copied block from chat / export"),
    rows: "8",
    "data-sticker-draft": "1",
  }) as HTMLTextAreaElement;
  const outNeedPre = el("pre", {
    class: "ref",
    style: "margin:0.65rem 0 0;font-size:0.85rem;line-height:1.35;white-space:pre-wrap",
  });
  const outNeedErr = el("div");
  const btnNeed = el("button", { class: "btn btn-primary", type: "button" }, tr("Compare to my missing"));
  btnNeed.addEventListener("click", async () => {
    outNeedErr.replaceChildren();
    if (!missingSet) await loadCrosscheckLists();
    if (!missingSet) {
      outNeedPre.textContent = "";
      outNeedErr.appendChild(el("div", { class: "msg-error" }, tr("Lists not loaded.")));
      return;
    }
    const { refs, errors } = parseTheirRefPaste(taNeed.value);
    const hints = albumHintsFromRows(dupByCanon, missingByCanon);
    const hits = sortRefsByAlbumOrder(
      [...new Set(refs.map((r) => canonicalRef(r)))].filter((c) => missingSet!.has(c)),
      hints,
    );
    outNeedPre.textContent =
      hits.length === 0 ? "(none — no overlap with your missing list.)" : formatRefsAsCompactLines(hits);
    lastNeedHits = [...hits];
    needCompared = true;
    syncTradeJumpButtons();
    if (errors.length > 0) {
      outNeedErr.appendChild(
        el(
          "div",
          { class: "banner-info", style: "margin-top:0.5rem;font-size:0.82rem;white-space:pre-wrap" },
          `Some lines could not be parsed:\n${errors.slice(0, 14).join("\n")}${errors.length > 14 ? "\n…" : ""}`,
        ),
      );
    }
  });
  const taNeedWrap = wrapFieldWithCopyButton(taNeed);
  cardNeed.appendChild(el("label", { class: "field" }, tr("Their list")));
  attachStickerRefAutocomplete(taNeed);
  cardNeed.appendChild(taNeedWrap);
  cardNeed.appendChild(btnNeed);
  cardNeed.appendChild(el("label", { class: "field" }, tr("You need from them (compact)")));
  cardNeed.appendChild(outNeedPre);
  cardNeed.appendChild(outNeedErr);

  const cardGive = el("div", { class: "card" });
  cardGive.appendChild(el("h3", {}, tr("Their missing → what I can give")));
  cardGive.appendChild(
    el(
      "p",
      { class: "muted", style: "margin:0 0 0.65rem;font-size:0.85rem" },
      "Intersection with your duplicate/spare list: stickers they need that you have at least one extra copy of.",
    ),
  );
  const taGive = el("textarea", {
    placeholder: tr("Their missing list (compact or one ref per line)"),
    rows: "8",
    "data-sticker-draft": "1",
  }) as HTMLTextAreaElement;
  const outGivePre = el("pre", {
    class: "ref",
    style: "margin:0.65rem 0 0;font-size:0.85rem;line-height:1.35;white-space:pre-wrap",
  });
  const outGiveErr = el("div");
  const btnGive = el("button", { class: "btn btn-primary", type: "button" }, tr("Compare to my spares"));
  btnGive.addEventListener("click", async () => {
    outGiveErr.replaceChildren();
    if (!dupGiveSet) await loadCrosscheckLists();
    if (!dupGiveSet) {
      outGivePre.textContent = "";
      outGiveErr.appendChild(el("div", { class: "msg-error" }, tr("Lists not loaded.")));
      return;
    }
    const { refs, errors } = parseTheirRefPaste(taGive.value);
    const hints = albumHintsFromRows(dupByCanon, missingByCanon);
    const hits = sortRefsByAlbumOrder(
      [...new Set(refs.map((r) => canonicalRef(r)))].filter((c) => dupGiveSet!.has(c)),
      hints,
    );
    outGivePre.textContent =
      hits.length === 0 ? "(none — no overlap with stickers you have as spares.)" : formatRefsAsCompactLines(hits);
    lastGiveHits = [...hits];
    giveCompared = true;
    syncTradeJumpButtons();
    if (errors.length > 0) {
      outGiveErr.appendChild(
        el(
          "div",
          { class: "banner-info", style: "margin-top:0.5rem;font-size:0.82rem;white-space:pre-wrap" },
          `Some lines could not be parsed:\n${errors.slice(0, 14).join("\n")}${errors.length > 14 ? "\n…" : ""}`,
        ),
      );
    }
  });
  const taGiveWrap = wrapFieldWithCopyButton(taGive);
  cardGive.appendChild(el("label", { class: "field" }, tr("Their missing")));
  attachStickerRefAutocomplete(taGive);
  cardGive.appendChild(taGiveWrap);
  cardGive.appendChild(btnGive);
  cardGive.appendChild(el("label", { class: "field" }, tr("You can give (compact)")));
  cardGive.appendChild(outGivePre);
  cardGive.appendChild(outGiveErr);

  function invalidateNeedCompare(): void {
    needCompared = false;
    lastNeedHits = null;
    syncTradeJumpButtons();
  }
  function invalidateGiveCompare(): void {
    giveCompared = false;
    lastGiveHits = null;
    syncTradeJumpButtons();
  }

  function syncTradeJumpButtons(): void {
    const ready = needCompared && giveCompared && lastNeedHits !== null && lastGiveHits !== null;
    btnSuggest.disabled = !ready || lastNeedHits!.length === 0 || lastGiveHits!.length === 0;
    btnSendAll.disabled = !ready || (lastNeedHits!.length === 0 && lastGiveHits!.length === 0);
  }

  const cardTradeJump = el("div", { class: "card" });
  cardTradeJump.appendChild(el("h3", {}, tr("Send to Trade")));
  cardTradeJump.appendChild(
    el(
      "p",
      { class: "muted", style: "margin:0 0 0.65rem;font-size:0.85rem;line-height:1.4" },
      "After you run both Compare buttons on the current text, you can open Trade with lists prefilled. Suggest trade pairs FWC with FWC, team photo with team photo, shield with shield, then players — equal count on both sides when possible. Send ALL copies every overlap (enables uneven counts if the two lists differ in length). You still review and execute on Trade.",
    ),
  );
  const btnSuggest = el("button", { class: "btn", type: "button", disabled: true }, tr("Suggest trade (fair pairs)"));
  const btnSendAll = el("button", { class: "btn", type: "button", disabled: true }, tr("Send ALL to Trade"));
  btnSuggest.addEventListener("click", () => {
    if (!needCompared || !giveCompared || lastNeedHits === null || lastGiveHits === null) return;
    const { give, take, leftoverGive, leftoverTake } = fairTradePairedLists(
      lastGiveHits,
      lastNeedHits,
      dupByCanon,
      missingByCanon,
    );
    if (give.length === 0 || take.length === 0) {
      setTradePrefillBanner(
        "Fair pairing found no same-type overlaps — use Send ALL to Trade or adjust the pasted lists.",
      );
      applyTradePrefill(give, take, give.length !== take.length, albumHintsFromRows(dupByCanon, missingByCanon));
      return;
    }
    const extra: string[] = [];
    if (leftoverGive.length) extra.push(`${leftoverGive.length} give ref(s) not paired by type`);
    if (leftoverTake.length) extra.push(`${leftoverTake.length} receive ref(s) not paired by type`);
    setTradePrefillBanner(
      extra.length
        ? `Fair pairs: ${give.length} ↔ ${take.length}. Not auto-paired: ${extra.join(" · ")} — originals still on Crosscheck.`
        : `Fair pairs: ${give.length} ↔ ${take.length} (FWC↔FWC, team photo↔team photo, shield↔shield, player↔player).`,
    );
    applyTradePrefill(give, take, false, albumHintsFromRows(dupByCanon, missingByCanon));
  });
  btnSendAll.addEventListener("click", () => {
    if (!needCompared || !giveCompared || lastNeedHits === null || lastGiveHits === null) return;
    const uneven = lastGiveHits.length !== lastNeedHits.length;
    setTradePrefillBanner(
      uneven
        ? `Prefilled ${lastGiveHits.length} you give ↔ ${lastNeedHits.length} you receive — uneven counts; “Allow uneven” is checked. Customize on Trade before executing.`
        : `Prefilled ${lastGiveHits.length} ↔ ${lastNeedHits.length}. Customize on Trade before executing.`,
    );
    applyTradePrefill(lastGiveHits, lastNeedHits, uneven, albumHintsFromRows(dupByCanon, missingByCanon));
  });
  cardTradeJump.appendChild(el("div", { class: "row", style: "flex-wrap:wrap;gap:0.5rem" }, btnSuggest, btnSendAll));

  taNeed.addEventListener("input", () => invalidateNeedCompare());
  taGive.addEventListener("input", () => invalidateGiveCompare());

  section.addEventListener(PANINI_CLEAR_STICKER_DRAFTS, () => {
    outNeedPre.textContent = "";
    outGivePre.textContent = "";
    outNeedErr.replaceChildren();
    outGiveErr.replaceChildren();
    needCompared = false;
    giveCompared = false;
    lastNeedHits = null;
    lastGiveHits = null;
    syncTradeJumpButtons();
  });

  section.appendChild(status);
  section.appendChild(intro);
  section.appendChild(cardNeed);
  section.appendChild(cardGive);
  section.appendChild(cardTradeJump);
  void loadCrosscheckLists();
  return section;
}

function buildTrade(): HTMLElement {
  const section = el("section", { class: "view", id: "view-trade" });
  views.trade = section;
  section.appendChild(el("h2", {}, tr("Trade")));
  const prefillBanner = el("div", {
    id: "trade-prefill-banner",
    class: "banner-info",
    style: "display:none;margin-bottom:0.65rem",
  });
  section.appendChild(prefillBanner);

  const giveTa = el("textarea", {
    id: "trade-give",
    placeholder: tr("Stickers you give (one per line)"),
    "data-sticker-draft": "1",
  }) as HTMLTextAreaElement;
  const takeTa = el("textarea", {
    id: "trade-take",
    placeholder: tr("Stickers you receive"),
    "data-sticker-draft": "1",
  }) as HTMLTextAreaElement;
  attachStickerRefAutocomplete(giveTa);
  attachStickerRefAutocomplete(takeTa);
  const giveWrap = wrapFieldWithCopyButton(giveTa);
  const takeWrap = wrapFieldWithCopyButton(takeTa);
  const strictCb = el("input", { type: "checkbox", id: "trade-strict" }) as HTMLInputElement;
  const unevenCb = el("input", { type: "checkbox", id: "trade-uneven" }) as HTMLInputElement;
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
    tradeResultCard.appendChild(el("h3", {}, tr("Trade undone")));
    const grid = el("div", { class: "trade-result-grid" });
    const colRm = el("div", { class: "trade-result-col trade-result-col--out" });
    colRm.appendChild(el("div", { class: "trade-result-col-title" }, tr("Returned / removed")));
    colRm.appendChild(renderRefChips(ur.gave));
    const colOk = el("div", { class: "trade-result-col trade-result-col--in" });
    colOk.appendChild(el("div", { class: "trade-result-col-title" }, tr("Restored to your album")));
    colOk.appendChild(renderRefChips(ur.received));
    grid.append(colRm, colOk);
    tradeResultCard.appendChild(grid);
  }

  function renderTradeOutcome(
    r: TradeResponse,
    forwardGive: string[],
    forwardTake: string[],
    hints: Map<string, TradeAlbumHint>,
  ): void {
    pendingUndo = { give: [...forwardGive], take: [...forwardTake] };
    tradeResultCard.style.display = "block";
    tradeResultCard.replaceChildren();
    tradeResultCard.appendChild(el("h3", {}, tr("Trade recorded")));

    if (r.warnings.length > 0) {
      for (const w of r.warnings) {
        tradeResultCard.appendChild(el("div", { class: "banner-info" }, w));
      }
    }

    const receiveLines = buildOrderedTradeReceiveLines(forwardTake, r.received, hints);
    const { newCount, spareCount } = countStickerActionLines(receiveLines);
    const countsText = trf("{given} given · {total} received: {newCount} new to album · {spareCount} spares.", {
      given: String(forwardGive.length),
      total: String(receiveLines.length),
      newCount: String(newCount),
      spareCount: String(spareCount),
    });

    if (receiveLines.length > 0) {
      renderStickerActionSummaryGrid(tradeResultCard, receiveLines, countsText);
      tradeResultCard.appendChild(renderStickerOrderedList(receiveLines, tr("In receive order:")));
    } else {
      tradeResultCard.appendChild(
        el("p", { class: "muted pack-preview-counts", style: "margin:0 0 0.65rem;font-size:0.9rem" }, countsText),
      );
    }

    if (forwardGive.length > 0) {
      const giveWrap = el("div", { style: "margin-top:0.75rem" });
      giveWrap.appendChild(el("div", { class: "trade-result-col-title" }, tr("Out of your album")));
      giveWrap.appendChild(renderRefChips(r.gave));
      tradeResultCard.appendChild(giveWrap);
    }

    const undoRow = el("div", { class: "trade-result-actions" });
    const undoBtn = el("button", { class: "btn", type: "button" }, tr("Undo this trade"));
    undoBtn.addEventListener("click", async () => {
      if (!pendingUndo) return;
      undoBtn.disabled = true;
      try {
        const ur = await undoTrade(pendingUndo.give, pendingUndo.take);
        pendingUndo = null;
        renderUndoOutcome(ur);
        void overviewPage.reload();
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
    setTradePrefillBanner("");
    updateTradePreview();
  }

  const previewCard = el("div", { class: "card trade-preview-card" });
  previewCard.appendChild(el("h3", {}, tr("Preview")));
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
        el("p", { style: "margin:0;font-size:0.9rem;color:var(--muted)" }, tr("Loading album data for preview…")),
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
        el("p", { style: "margin:0;font-size:0.9rem;color:var(--muted)" }, tr("Enter refs above to see an analysis.")),
      );
    }
  }

  previewCard.appendChild(previewHost);
  giveTa.addEventListener("input", onGiveTakeInput);
  takeTa.addEventListener("input", onGiveTakeInput);

  const submit = el("button", { class: "btn btn-primary", type: "button" }, tr("Execute trade"));

  submit.addEventListener("click", async () => {
    clearTradeOutcome();
    try {
      const give = parseRefLines(giveTa.value);
      const take = parseRefLines(takeTa.value);
      const hintsSnap = buildTradeAlbumHintMap();
      const r = await executeTrade(give, take, strictCb.checked, unevenCb.checked);
      giveTa.value = "";
      takeTa.value = "";
      renderTradeOutcome(r, give, take, hintsSnap);
      void overviewPage.reload();
      await loadTradePreviewData();
      updateTradePreview();
    } catch (e) {
      tradeResultCard.style.display = "block";
      tradeResultCard.replaceChildren(errBox(e));
    }
  });

  const grid = el("div", { class: "trade-grid" });
  grid.appendChild(
    el("div", { class: "card" }, el("h3", {}, tr("You give")), giveWrap, countBadge),
  );
  grid.appendChild(
    el("div", { class: "card" }, el("h3", {}, tr("You receive")), takeWrap),
  );

  section.appendChild(grid);
  section.appendChild(previewCard);
  section.appendChild(infoUneven);
  section.appendChild(
    el("div", { class: "checkbox-row" }, strictCb, el("label", { for: "trade-strict" }, tr("Strict: only trade duplicates (qty ≥ 2)"))),
  );
  section.appendChild(
    el("div", { class: "checkbox-row" }, unevenCb, el("label", { for: "trade-uneven" }, tr("Allow uneven counts"))),
  );
  section.appendChild(submit);
  section.appendChild(tradeResultCard);

  const dupCard = el("div", { class: "card" });
  const dupHead = el("div", { class: "trade-dup-head" });
  dupHead.appendChild(el("h3", {}, tr("Duplicates (click row to add to Give)")));
  dupHead.appendChild(el("span", { id: "trade-dup-count", class: "muted trade-dup-count" }, "—"));
  dupCard.appendChild(dupHead);
  const dupToolbar = el("div", { class: "trade-dup-toolbar row" });
  const sortLabel = el("span", { class: "muted", style: "font-size:0.85rem" }, tr("Sort:"));
  const dupSortSpares = el(
    "button",
    { class: "btn btn-ghost btn-compact trade-dup-sort-btn", type: "button", "data-sort": "spares" },
    tr("Most spares"),
  );
  const dupSortAlbum = el(
    "button",
    { class: "btn btn-ghost btn-compact trade-dup-sort-btn", type: "button", "data-sort": "album" },
    tr("Album order"),
  );
  dupSortSpares.addEventListener("click", () => {
    if (tradeDupSortMode === "spares") return;
    tradeDupSortMode = "spares";
    renderTradeDupPicker();
  });
  dupSortAlbum.addEventListener("click", () => {
    if (tradeDupSortMode === "album") return;
    tradeDupSortMode = "album";
    renderTradeDupPicker();
  });
  const dupExpandBtn = el("button", {
    class: "btn btn-ghost btn-compact",
    type: "button",
    id: "trade-dup-expand",
  }, tr("Expand list"));
  dupExpandBtn.addEventListener("click", () => {
    tradeDupExpanded = !tradeDupExpanded;
    syncTradeDupPickerChrome();
  });
  dupToolbar.append(sortLabel, dupSortSpares, dupSortAlbum, dupExpandBtn);
  dupCard.appendChild(dupToolbar);
  const dupPicker = el("div", { id: "trade-dup-picker", class: "trade-dup-picker" });
  dupCard.appendChild(dupPicker);
  section.appendChild(dupCard);

  section.addEventListener(PANINI_CLEAR_STICKER_DRAFTS, () => {
    clearTradeOutcome();
    setTradePrefillBanner("");
  });

  updateTradePreview();

  return section;
}
