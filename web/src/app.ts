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
import { getLocale, setLocale, tr, trf } from "./i18n";
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
/** Canonical ref → qty/spares for stickers with qty > 1. */
let tradeDupMap: Map<string, { qty: number; spare: number }> | null = null;
/** Set when missing/duplicate list fetch fails — preview cannot run until fixed. */
let tradePreviewLoadError: string | null = null;

let tradeDupRows: ListStickerRow[] = [];

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
    if (box) box.textContent = tr("Could not load lists.");
    document.getElementById("trade-give")?.dispatchEvent(new Event("input"));
  }
}

function renderTradeDupPicker(): void {
  const box = document.getElementById("trade-dup-picker");
  if (!box) return;
  try {
    box.innerHTML = "";
    const tbl = el("table", { class: "data" });
    const thead = el("thead", {}, el("tr", {}, el("th", {}, tr("ref")), el("th", {}, tr("spares"))));
    const tbody = el("tbody");
    for (const r of tradeDupRows.slice(0, 80)) {
      const row = el("tr", { style: "cursor:pointer" });
      row.appendChild(el("td", { class: "ref" }, r.ref));
      row.appendChild(el("td", {}, String(r.spare_copies ?? r.qty - 1)));
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
    if (tradeDupRows.length > 80) {
      box.appendChild(
        el("p", { style: "font-size:0.85rem;color:var(--muted)" }, trf("Showing 80 of {n}. See Lists for full table.", { n: String(tradeDupRows.length) })),
      );
    }
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
    ["pack-outlook", tr("Pack outlook")],
    ["lists", tr("Lists")],
    ["desk", tr("Sticker desk")],
    ["pack", tr("Pack")],
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
  main.appendChild(buildPack());
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
function applyTradePrefill(give: string[], take: string[], uneven: boolean): void {
  const giveTa = document.getElementById("trade-give") as HTMLTextAreaElement | null;
  const takeTa = document.getElementById("trade-take") as HTMLTextAreaElement | null;
  const unevenCb = document.getElementById("trade-uneven") as HTMLInputElement | null;
  const g = [...new Set(give.map((r) => canonicalRef(r)))];
  const t = [...new Set(take.map((r) => canonicalRef(r)))];
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

/** Large % + progress bar for unique-slot completion (Overview). */
function collectionProgressBlock(pct: number, filled: number, total: number): HTMLElement {
  const p = Math.min(100, Math.max(0, pct));
  const wrap = el("div", { class: "collection-progress" });
  const head = el("div", { class: "collection-progress-head" });
  head.appendChild(el("span", { class: "collection-progress-pct" }, `${Math.round(p)}%`));
  head.appendChild(
    el("span", { class: "collection-progress-meta" }, trf("{filled} / {total} unique", { filled: String(filled), total: String(total) })),
  );
  wrap.appendChild(head);
  const track = el("div", {
    class: "collection-progress-track",
    role: "progressbar",
    "aria-valuenow": String(Math.round(p)),
    "aria-valuemin": "0",
    "aria-valuemax": "100",
    "aria-label": trf("Album {pct} percent complete", { pct: String(Math.round(p)) }),
  });
  const fill = el("div", { class: "collection-progress-fill" });
  fill.style.width = `${p}%`;
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
  const text = emptyAlbum ? whenEmpty : tieNote;
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
          "Nothing to rank yet — add stickers to see which ref piles up the most.",
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
      el("p", { class: "stat-widget__hint" }, `${miss} sticker${miss === 1 ? "" : "s"} still missing here — trade priority?`),
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
      w.appendChild(el("div", { class: "stat-widget__eyebrow" }, tr("Team shields")));
      w.appendChild(
        el("p", { class: "stat-widget__hint", style: "margin:0 0 0.35rem" }, tr("Slot 1 on every team page (48 crest stickers).")),
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
      w.appendChild(el("div", { class: "stat-widget__eyebrow" }, tr("Team photos")));
      w.appendChild(
        el("p", { class: "stat-widget__hint", style: "margin:0 0 0.35rem" }, tr("Slot 13 on every team page (48 squad photos).")),
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
    w.appendChild(el("div", { class: "stat-widget__eyebrow" }, tr("Full team pages")));
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
        "Each row is one national team page (20 stickers). Shield is slot 1, team photo is slot 13. Flags show whether you have at least one copy. Click column headers to sort.",
      ),
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
  sessionAddReadRow(tr("Packs opened"), sessionReadVals.packs);
  sessionAddReadRow(tr("Traded out"), sessionReadVals.out);
  sessionAddReadRow(tr("Traded in"), sessionReadVals.inn);

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
    const emptyAlbum = m.unique_slots_filled === 0;
    metricsHost.innerHTML = "";
    metricsHost.appendChild(el("h3", {}, tr("Collection")));
    metricsHost.appendChild(
      collectionProgressBlock(m.pct_complete_unique, m.unique_slots_filled, m.album_unique_slots),
    );
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
        await navigator.clipboard.writeText(paste);
        copyAlbum.textContent = "Copied!";
        setTimeout(() => {
          copyAlbum.textContent = "Copy album line";
        }, 1600);
      } catch {
        copyAlbum.textContent = "Copy failed";
      }
    });
    const copyRef = el("button", { class: "btn", type: "button" }, tr("Copy app ref"));
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
      await navigator.clipboard.writeText(t);
      copyMiss.textContent = "Copied!";
      setTimeout(() => {
        copyMiss.textContent = "Copy missing";
      }, 1500);
    } catch (e) {
      alert(String(e));
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
      await navigator.clipboard.writeText(t);
      copyDup.textContent = "Copied!";
      setTimeout(() => {
        copyDup.textContent = "Copy dups";
      }, 1500);
    } catch (e) {
      alert(String(e));
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
  section.appendChild(el("h2", {}, tr("Sticker desk")));

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

  const addCard = el("div", { class: "card" });
  addCard.appendChild(el("h3", {}, tr("Add stickers")));
  const batchAdd = el("textarea", {
    placeholder: `MEX:5\n00\nFWC 14\nRSA 7\nMEX: 1, 2, 3\nFWC:12 x3`,
    "data-sticker-draft": "1",
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
  const applyAdd = el("button", { class: "btn btn-primary", type: "button" }, tr("Apply adds"));
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
      addMsg.appendChild(el("div", { class: "banner-info" }, tr("Use Apply adds first, or enter a total manually via Overview → session.")));
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

  addCard.appendChild(el("label", { class: "field" }, tr("Batch (optional: REF x3)")));
  addCard.appendChild(batchAdd);
  attachStickerRefAutocomplete(batchAdd);
  addCard.appendChild(addPreview);
  addCard.appendChild(el("div", { class: "row" }, applyAdd, suggestPacksBtn));
  addCard.appendChild(addMsg);

  const remCard = el("div", { class: "card" });
  remCard.appendChild(el("h3", {}, tr("Remove stickers")));
  const batchRem = el("textarea", { placeholder: tr("Same format as add"), "data-sticker-draft": "1" }) as HTMLTextAreaElement;
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
  remCard.appendChild(batchRem);
  attachStickerRefAutocomplete(batchRem);
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
    lookupResultHost.replaceChildren();
    lookupErr.replaceChildren();
    addPreview.textContent = "";
    addMsg.replaceChildren();
    remMsg.replaceChildren();
    singleMsg.replaceChildren();
    lastAddTotal = 0;
  });

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

function packStickerListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function buildPack(): HTMLElement {
  const section = el("section", { class: "view", id: "view-pack" });
  views.pack = section;
  section.appendChild(el("h2", {}, tr("Open pack")));

  const card = el("div", { class: "card" });
  card.appendChild(
    el(
      "p",
      { class: "muted", style: "margin:0 0 0.75rem;font-size:0.9rem;line-height:1.45" },
      "Use Check pack to see new album slots vs duplicates/spares (sorted by printed page). Register only when it looks right. Undo matches the last registration until you edit this list or reload — same idea as Trade.",
    ),
  );

  const ta = el("textarea", {
    placeholder: trf("One ref per line (often {n}; fewer or more is ok)", { n: String(STICKERS_PER_PACK) }),
    "data-sticker-draft": "1",
  }) as HTMLTextAreaElement;

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

  type PackValidated = { stickers: string[]; perPack: number; check: PackCheckResponse };
  let lastValidated: PackValidated | null = null;
  let pendingUndo: { stickers: string[]; packs_opened_delta: number } | null = null;

  const staleHint = el("p", {
    class: "muted",
    hidden: true,
    style: "margin:0.35rem 0 0;font-size:0.82rem",
  });
  staleHint.textContent = "List or nominal size changed — run Check pack again before registering.";

  const previewHost = el("div", { class: "pack-preview-host" });
  const checkBtn = el("button", { class: "btn", type: "button" }, tr("Check pack"));
  const regBtn = el("button", { class: "btn btn-primary", type: "button", disabled: true }, tr("Register pack"));
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

  function formatPackCheckRowNewSlot(r: PackCheckRow): string {
    const grp = r.album_index_group != null && r.album_index_group !== "" ? `Gr. ${r.album_index_group} · ` : "";
    return `${r.ref} · ${grp}p.${r.album_printed_page}`;
  }

  function formatPackCheckRowDupSlot(r: PackCheckRow): string {
    const grp = r.album_index_group != null && r.album_index_group !== "" ? `Gr. ${r.album_index_group} · ` : "";
    return `${r.ref} · ${grp}p.${r.album_printed_page} (qty before ${r.qty_before})`;
  }

  function appendPackCheckColumn(
    title: string,
    rows: PackCheckRow[],
    emptyMsg: string,
    colMod: string,
    formatRow: (r: PackCheckRow) => string,
  ): HTMLElement {
    const col = el("div", { class: `trade-result-col ${colMod}` });
    col.appendChild(el("div", { class: "trade-result-col-title" }, title));
    if (rows.length === 0) {
      col.appendChild(el("p", { class: "trade-result-empty" }, emptyMsg));
    } else {
      const ul = el("ul", { class: "compact-list", style: "margin:0;padding-left:1.1rem;font-size:0.88rem" });
      for (const r of rows) {
        ul.appendChild(el("li", {}, formatRow(r)));
      }
      col.appendChild(ul);
    }
    return col;
  }

  function renderPackCheckPreview(c: PackCheckResponse): void {
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
    previewHost.appendChild(
      el(
        "p",
        { class: "muted", style: "margin:0.5rem 0;font-size:0.9rem" },
        `${c.sticker_count} sticker(s). Session packs_opened += ${c.packs_opened_delta} (nominal ${c.per_pack} per pack, rounded).`,
      ),
    );
    const grid = el("div", { class: "trade-result-grid" });
    grid.appendChild(
      appendPackCheckColumn(
        "Goes to album (empty slot)",
        c.new_to_album,
        "None — every line is already in the album at least once.",
        "trade-result-col--in",
        formatPackCheckRowNewSlot,
      ),
    );
    grid.appendChild(
      appendPackCheckColumn(
        "Adds spare / duplicate",
        c.would_duplicate,
        "None — every line fills a missing slot.",
        "trade-result-col--out",
        formatPackCheckRowDupSlot,
      ),
    );
    previewHost.appendChild(grid);
  }

  ta.addEventListener("input", () => {
    invalidatePackValidation();
    if (previewHost.childNodes.length > 0) staleHint.hidden = false;
  });

  checkBtn.addEventListener("click", async () => {
    previewHost.replaceChildren();
    staleHint.hidden = true;
    try {
      const stickers = parseRefLines(ta.value);
      const pp = getPackPerPack();
      const c = await checkPack(stickers, pp);
      lastValidated = { stickers, perPack: pp, check: c };
      renderPackCheckPreview(c);
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
      stickers = parseRefLines(ta.value);
    } catch (e) {
      resultCard.style.display = "block";
      resultCard.replaceChildren(errBox(e));
      return;
    }
    const pp = getPackPerPack();
    if (!lastValidated || !packStickerListsEqual(stickers, lastValidated.stickers) || pp !== lastValidated.perPack) {
      resultCard.style.display = "block";
      resultCard.replaceChildren(
        el("div", { class: "msg-error" }, tr("Run Check pack again — the list or nominal per-pack no longer matches the preview.")),
      );
      regBtn.disabled = true;
      return;
    }
    try {
      const r = await openPack(stickers, pp);
      pendingUndo = { stickers: [...stickers], packs_opened_delta: r.packs_opened_delta };
      ta.value = "";
      invalidatePackValidation();
      previewHost.replaceChildren();
      staleHint.hidden = true;

      resultCard.style.display = "block";
      resultCard.replaceChildren();
      resultCard.appendChild(el("h3", {}, tr("Pack registered")));
      resultCard.appendChild(
        el(
          "p",
          { class: "muted", style: "margin:0 0 0.65rem" },
          `${r.sticker_count} stickers · packs_opened +${r.packs_opened_delta} · ${r.added_as_new.length} new slot(s) · ${r.added_as_duplicate.length} spare/duplicate line(s).`,
        ),
      );
      for (const w of r.warnings) {
        resultCard.appendChild(el("div", { class: "banner-info" }, w));
      }
      if (r.in_pack_duplicates.length > 0) {
        const parts = r.in_pack_duplicates.map((d) => `${d.ref} ×${d.occurrences}`);
        resultCard.appendChild(
          el("div", { class: "banner-info" }, `In-pack repeats: ${parts.join(", ")}.`),
        );
      }
      const undoRow = el("div", { class: "trade-result-actions" });
      const undoBtn = el("button", { class: "btn", type: "button" }, tr("Undo this pack"));
      undoBtn.addEventListener("click", async () => {
        if (!pendingUndo) return;
        undoBtn.disabled = true;
        try {
          await undoPackOpen(pendingUndo.stickers, pendingUndo.packs_opened_delta);
          pendingUndo = null;
          resultCard.replaceChildren();
          resultCard.appendChild(el("h3", {}, tr("Pack undone")));
          resultCard.appendChild(
            el("p", { class: "muted" }, tr("Inventory and packs_opened were restored. Paste the list again if you still want to register it.")),
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
      void overviewPage.reload();
      void loadTradePreviewData();
    } catch (e) {
      resultCard.style.display = "block";
      resultCard.replaceChildren(errBox(e));
    }
  });

  const btnRow = el("div", { class: "row", style: "gap:0.5rem;flex-wrap:wrap;margin:0.5rem 0" });
  btnRow.append(checkBtn, regBtn);

  card.appendChild(el("label", { class: "field" }, tr("Stickers in this pack (one ref per line)")));
  card.appendChild(ta);
  attachStickerRefAutocomplete(ta);
  card.appendChild(nominalRow);
  card.appendChild(btnRow);
  card.appendChild(staleHint);
  card.appendChild(previewHost);

  section.appendChild(card);
  section.appendChild(resultCard);

  section.addEventListener(PANINI_CLEAR_STICKER_DRAFTS, () => {
    invalidatePackValidation();
    previewHost.replaceChildren();
    staleHint.hidden = true;
    resultCard.style.display = "none";
    resultCard.replaceChildren();
    pendingUndo = null;
  });

  return section;
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
  const cats = [...by.keys()].sort((a, b) => {
    if (a === "FWC") return -1;
    if (b === "FWC") return 1;
    return a.localeCompare(b);
  });
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
  const gCanon = [...new Set(giveRefs.map((r) => canonicalRef(r)))].sort();
  const tCanon = [...new Set(takeRefs.map((r) => canonicalRef(r)))].sort();

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

  const giveOut: string[] = [];
  const takeOut: string[] = [];
  for (const b of TRADE_PAIR_ORDER) {
    const g = giveQueues[b];
    const t = takeQueues[b];
    const n = Math.min(g.length, t.length);
    for (let i = 0; i < n; i++) {
      giveOut.push(g[i]!);
      takeOut.push(t[i]!);
    }
  }

  const pairedGive = new Set(giveOut);
  const pairedTake = new Set(takeOut);
  const leftoverGive = gCanon.filter((r) => !pairedGive.has(r));
  const leftoverTake = tCanon.filter((r) => !pairedTake.has(r));
  return { give: giveOut, take: takeOut, leftoverGive, leftoverTake };
}

function buildPackOutlook(): HTMLElement {
  const section = el("section", { class: "view", id: "view-pack-outlook" });
  views["pack-outlook"] = section;
  section.appendChild(el("h2", {}, tr("Pack outlook")));

  const intro = el("p", {
    class: "muted",
    style: "margin:0 0 1rem;font-size:0.88rem;line-height:1.45;max-width:52rem",
  });
  intro.textContent =
    "Rough Monte Carlo from your current album: each pack draws random slots over the whole album. The slider is the chance that after each pack you trade one duplicate for a slot you still need. Higher values assume you move spares into missing slots more often — so fewer packs to finish. This is a toy model, not real pack odds.";

  const rowTop = el("div", { class: "pack-outlook-top", style: "display:flex;flex-wrap:wrap;gap:1.25rem;align-items:flex-start;margin-bottom:1rem" });
  const ringWrap = el("div", { style: "flex:0 0 auto" });
  const ringHost = el("div", { id: "pack-outlook-ring" });
  ringWrap.appendChild(ringHost);

  const sliderCard = el("div", { class: "card", style: "flex:1 1 18rem;min-width:min(100%,16rem)" });
  sliderCard.appendChild(el("h3", { style: "margin-top:0" }, tr("Trading repeats")));
  const sliderRow = el("div", { class: "pack-outlook-slider-row", style: "display:flex;align-items:center;gap:0.75rem;flex-wrap:wrap" });
  const range = el("input", {
    type: "range",
    min: "0",
    max: "100",
    value: "30",
    class: "pack-outlook-range",
    "aria-label": "How often you trade spare stickers: percent of times a duplicate could be swapped for a missing slot after each simulated pack",
  }) as HTMLInputElement;
  const pctLabel = el("span", { class: "ref", style: "min-width:4.5rem" }, tr("30%"));
  sliderRow.appendChild(range);
  sliderRow.appendChild(pctLabel);
  sliderCard.appendChild(sliderRow);
  const tradeRepeatHint = el("p", {
    class: "muted",
    style: "margin:0.5rem 0 0;font-size:0.82rem;line-height:1.45",
  }) as HTMLParagraphElement;
  sliderCard.appendChild(tradeRepeatHint);

  function syncTradeRepeatHint(): void {
    const v = range.value;
    pctLabel.textContent = `${v}%`;
    tradeRepeatHint.textContent = `Assuming you trade ${v}% of spare stickers. Uses ${STICKERS_PER_PACK} stickers per pack — same as Pack.`;
  }
  syncTradeRepeatHint();

  rowTop.appendChild(ringWrap);
  rowTop.appendChild(sliderCard);
  section.appendChild(intro);
  section.appendChild(rowTop);

  const status = el("p", {
    class: "muted",
    style: "margin:0 0 0.75rem;font-size:0.9rem;line-height:1.45",
  });
  section.appendChild(status);

  const statsCard = el("div", { class: "card" });
  statsCard.appendChild(el("h3", { style: "margin-top:0" }, tr("How many more packs?")));
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

  function renderFromData(d: PackOutlookResponse): void {
    ringHost.replaceChildren(analyticsPctRing(d.pct_complete_unique, "unique slots"));
    const miss = d.unique_slots_missing;
    if (miss <= 0) {
      statsBody.replaceChildren(
        el("p", { style: "margin:0" }, tr("Album complete on unique slots — no further packs needed in this model.")),
        el(
          "p",
          { class: "muted", style: "margin:0.5rem 0 0;font-size:0.88rem" },
          `Session packs opened (counter): ${d.session_packs_opened}. Spare copies in inventory: ${d.spare_copies}.`,
        ),
      );
      disc.textContent = d.disclaimer;
      return;
    }
    const p50 = d.p50_packs;
    const p90 = d.p90_packs;
    const meanP = d.mean_packs;
    const band =
      p90 > p50
        ? `Typical spread in this run: about ${p50}–${p90} packs (50th–90th percentile).`
        : `50th percentile ≈ ${p50} packs; 90th ≈ ${p90} packs.`;
    const mid = el(
      "p",
      { style: "margin:0.65rem 0 0" },
      "From here, median ≈ ",
      el("strong", {}, String(p50)),
      " more packs (~",
      String(d.p50_stickers),
      " sticker pulls), mean ≈ ",
      String(meanP),
      " packs. ",
      band,
    );
    const tail = el(
      "p",
      { class: "muted", style: "margin:0.55rem 0 0;font-size:0.88rem" },
      `Session packs opened (counter): ${d.session_packs_opened} — simulation restarts from your current gaps, it does not replay those opens.`,
    );
    const warn = d.truncated_note
      ? el("p", { class: "msg-error", style: "margin:0.55rem 0 0;font-size:0.88rem" }, d.truncated_note)
      : null;
    statsBody.replaceChildren(
      el(
        "p",
        { style: "margin:0" },
        `You are ${Math.round(d.pct_complete_unique)}% done on unique slots (${d.album_unique_slots - miss} / ${d.album_unique_slots}). Still missing ${miss} slots.`,
      ),
      mid,
      tail,
      ...(warn ? [warn] : []),
    );
    disc.textContent = d.disclaimer;
  }

  async function loadProjection(): Promise<void> {
    const mySeq = ++seq;
    const tradeP = Number(range.value) / 100;
    syncTradeRepeatHint();
    status.textContent = "Running simulation…";
    statsBody.replaceChildren();
    try {
      const d = await getPackOutlook(tradeP, { perPack: STICKERS_PER_PACK });
      if (mySeq !== seq) return;
      status.textContent =
        d.trials_used > 0
          ? `Based on ${d.trials_used} Monte Carlo trials (${d.trade_repeat_p === 0 ? "packs only" : `trade-after-pack chance ${Math.round(d.trade_repeat_p * 100)}%`}).`
          : "Album already complete on unique slots.";
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
    syncTradeRepeatHint();
    scheduleLoad();
  });

  packOutlookPage.reload = loadProjection;

  void loadProjection();
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
    const hits = [...new Set(refs.map((r) => canonicalRef(r)))].filter((c) => missingSet!.has(c));
    hits.sort();
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
  cardNeed.appendChild(el("label", { class: "field" }, tr("Their list")));
  cardNeed.appendChild(taNeed);
  attachStickerRefAutocomplete(taNeed);
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
    const hits = [...new Set(refs.map((r) => canonicalRef(r)))].filter((c) => dupGiveSet!.has(c));
    hits.sort();
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
  cardGive.appendChild(el("label", { class: "field" }, tr("Their missing")));
  cardGive.appendChild(taGive);
  attachStickerRefAutocomplete(taGive);
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
      applyTradePrefill(give, take, give.length !== take.length);
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
    applyTradePrefill(give, take, false);
  });
  btnSendAll.addEventListener("click", () => {
    if (!needCompared || !giveCompared || lastNeedHits === null || lastGiveHits === null) return;
    const uneven = lastGiveHits.length !== lastNeedHits.length;
    setTradePrefillBanner(
      uneven
        ? `Prefilled ${lastGiveHits.length} you give ↔ ${lastNeedHits.length} you receive — uneven counts; “Allow uneven” is checked. Customize on Trade before executing.`
        : `Prefilled ${lastGiveHits.length} ↔ ${lastNeedHits.length}. Customize on Trade before executing.`,
    );
    applyTradePrefill(lastGiveHits, lastNeedHits, uneven);
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

  function renderTradeOutcome(r: TradeResponse, forwardGive: string[], forwardTake: string[]): void {
    pendingUndo = { give: [...forwardGive], take: [...forwardTake] };
    tradeResultCard.style.display = "block";
    tradeResultCard.replaceChildren();
    tradeResultCard.appendChild(el("h3", {}, tr("Trade recorded")));
    tradeResultCard.appendChild(
      el(
        "p",
        { class: "trade-result-lede muted" },
        "Text boxes cleared. Undo puts inventory and session trade counters back the way they were, until you change these lists again.",
      ),
    );

    const grid = el("div", { class: "trade-result-grid" });
    const colOut = el("div", { class: "trade-result-col trade-result-col--out" });
    colOut.appendChild(el("div", { class: "trade-result-col-title" }, tr("Out of your album")));
    colOut.appendChild(renderRefChips(r.gave));
    const colIn = el("div", { class: "trade-result-col trade-result-col--in" });
    colIn.appendChild(el("div", { class: "trade-result-col-title" }, tr("Into your album")));
    colIn.appendChild(renderRefChips(r.received));
    grid.append(colOut, colIn);
    tradeResultCard.appendChild(grid);

    if (r.warnings.length > 0) {
      const wbox = el("div", { class: "banner-info trade-result-warn" });
      wbox.appendChild(el("strong", {}, tr("Notes — ")));
      wbox.appendChild(document.createTextNode(r.warnings.join(" · ")));
      tradeResultCard.appendChild(wbox);
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
    el("div", { class: "card" }, el("h3", {}, tr("You give")), giveTa, countBadge),
  );
  grid.appendChild(
    el("div", { class: "card" }, el("h3", {}, tr("You receive")), takeTa),
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
  dupCard.appendChild(el("h3", {}, tr("Duplicates (click row to add to Give)")));
  const dupPicker = el("div", { id: "trade-dup-picker", class: "compact-list" });
  dupCard.appendChild(dupPicker);
  section.appendChild(dupCard);

  section.addEventListener(PANINI_CLEAR_STICKER_DRAFTS, () => {
    clearTradeOutcome();
    setTradePrefillBanner("");
  });

  updateTradePreview();

  return section;
}
