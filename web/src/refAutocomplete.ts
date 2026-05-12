/**
 * Autocomplete 3-letter team codes only (before `:`). After `:` is typed, no suggestions.
 * Uses catalog from GET /catalog/sticker-refs (unique TEAM from refs like TEAM:n).
 * Keys when open: ↑/↓, Enter or Tab to accept, Esc to close. Tab does not move focus while accepting.
 */

import { getStickerRefsCatalog } from "./api";

let cachedRefs: string[] | null = null;

async function ensureRefs(): Promise<string[]> {
  if (cachedRefs) return cachedRefs;
  const { refs } = await getStickerRefsCatalog();
  cachedRefs = refs.slice().sort();
  return cachedRefs;
}

/** Invalidate after catalog could change (rare for this app). */
export function invalidateStickerRefCatalogCache(): void {
  cachedRefs = null;
}

export type TeamPrefixCompletion = {
  lineStart: number;
  /** Uppercase partial team letters (1–3), no colon. */
  prefix: string;
  tokenStart: number;
  caret: number;
};

/**
 * If the text before `caret` on the current line ends with 1–3 letters at a token start
 * and there is no `:` in that token yet, return the range to replace with `TEAM:`.
 */
export function getTeamPrefixCompletionState(value: string, caret: number): TeamPrefixCompletion | null {
  if (caret < 0) return null;
  const c = Math.min(caret, value.length);
  const lineStart = value.lastIndexOf("\n", c - 1) + 1;
  const before = value.slice(lineStart, c);
  const re = /(?:^|[\s,;])([A-Za-z]{1,3})$/;
  const m = before.match(re);
  if (!m) return null;
  const letters = m[1]!;
  const prefix = letters.toUpperCase();
  const tokenStart = lineStart + (before.length - letters.length);
  return { lineStart, prefix, tokenStart, caret: c };
}

/** Unique TEAM codes (AAA) from refs shaped AAA:n… */
export function teamsFromStickerRefs(refs: string[]): string[] {
  const s = new Set<string>();
  for (const r of refs) {
    const m = r.match(/^([A-Za-z]{3}):/);
    if (m) s.add(m[1]!.toUpperCase());
  }
  return [...s].sort();
}

function suggestionsForTeams(teams: string[], prefix: string): string[] {
  const p = prefix.toUpperCase();
  return teams.filter((t) => t.startsWith(p)).slice(0, 48);
}

function positionPopup(anchor: HTMLElement, popup: HTMLElement): void {
  const r = anchor.getBoundingClientRect();
  popup.style.position = "fixed";
  popup.style.left = `${Math.max(8, r.left)}px`;
  popup.style.top = `${r.bottom + 4}px`;
  popup.style.minWidth = `${Math.min(Math.max(r.width, 160), 320)}px`;
  popup.style.maxWidth = `${Math.max(200, window.innerWidth - 16)}px`;
  popup.style.zIndex = "10000";
}

/**
 * Attach team-prefix autocomplete to a field. Safe to call multiple times (one popup per field).
 */
export function attachStickerRefAutocomplete(el: HTMLInputElement | HTMLTextAreaElement): void {
  if ((el as HTMLElement).dataset.refAc === "1") return;
  (el as HTMLElement).dataset.refAc = "1";

  const popup = document.createElement("div");
  popup.className = "sticker-ref-ac";
  popup.setAttribute("role", "listbox");
  popup.style.display = "none";
  popup.tabIndex = -1;
  document.body.appendChild(popup);

  let selIdx = 0;
  let lastSuggestions: string[] = [];
  let lastState: TeamPrefixCompletion | null = null;
  let scrollBound = false;

  const onScrollClose = (): void => {
    if (popup.style.display !== "none") close();
  };

  function close(): void {
    popup.style.display = "none";
    popup.replaceChildren();
    lastSuggestions = [];
    lastState = null;
    if (scrollBound) {
      window.removeEventListener("scroll", onScrollClose, true);
      scrollBound = false;
    }
  }

  function highlight(): void {
    const items = popup.querySelectorAll(".sticker-ref-ac__item");
    items.forEach((node, i) => {
      node.classList.toggle("sticker-ref-ac__item--active", i === selIdx);
    });
    const active = items[selIdx] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }

  /** Insert `TEAM:` so the user types the number without further autocomplete. */
  function apply(team: string): void {
    const st = lastState;
    if (!st) return;
    const v = el.value;
    const start = st.tokenStart;
    const end = st.caret;
    const insert = `${team}:`;
    const next = v.slice(0, start) + insert + v.slice(end);
    el.value = next;
    const newCaret = start + insert.length;
    el.setSelectionRange(newCaret, newCaret);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    el.focus();
  }

  async function openOrUpdate(): Promise<void> {
    const caret = el.selectionStart ?? el.value.length;
    const st = getTeamPrefixCompletionState(el.value, caret);
    if (!st) {
      close();
      return;
    }
    const refs = await ensureRefs();
    const teams = teamsFromStickerRefs(refs);
    const list = suggestionsForTeams(teams, st.prefix);
    if (list.length === 0) {
      close();
      return;
    }
    lastState = st;
    lastSuggestions = list;
    selIdx = 0;
    popup.replaceChildren();
    for (const team of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sticker-ref-ac__item";
      b.setAttribute("role", "option");
      b.textContent = team;
      b.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        lastState = st;
        lastSuggestions = list;
        apply(team);
      });
      popup.appendChild(b);
    }
    positionPopup(el, popup);
    popup.style.display = "block";
    if (!scrollBound) {
      window.addEventListener("scroll", onScrollClose, true);
      scrollBound = true;
    }
    highlight();
  }

  function onKeyDown(ev: Event): void {
    const ke = ev as KeyboardEvent;
    if (popup.style.display === "none" || lastSuggestions.length === 0) return;
    if (ke.key === "Escape") {
      ke.preventDefault();
      ke.stopImmediatePropagation();
      close();
      return;
    }
    if (ke.key === "ArrowDown") {
      ke.preventDefault();
      ke.stopImmediatePropagation();
      selIdx = (selIdx + 1) % lastSuggestions.length;
      highlight();
      return;
    }
    if (ke.key === "ArrowUp") {
      ke.preventDefault();
      ke.stopImmediatePropagation();
      selIdx = (selIdx - 1 + lastSuggestions.length) % lastSuggestions.length;
      highlight();
      return;
    }
    if ((ke.key === "Enter" && !ke.shiftKey) || (ke.key === "Tab" && !ke.shiftKey)) {
      const team = lastSuggestions[selIdx];
      if (team) {
        ke.preventDefault();
        ke.stopImmediatePropagation();
        apply(team);
      }
      return;
    }
  }

  el.addEventListener("input", () => void openOrUpdate());
  el.addEventListener("click", () => void openOrUpdate());
  el.addEventListener("keyup", () => void openOrUpdate());
  el.addEventListener("keydown", onKeyDown);
  el.addEventListener("blur", () => window.setTimeout(close, 180));
}
