/**
 * Autocomplete sticker refs after `TEAM:` (e.g. `MEX:` → MEX:1 … MEX:20).
 * Works on inputs and textareas; uses catalog from GET /catalog/sticker-refs.
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

export type TeamColonCompletion = {
  lineStart: number;
  team: string;
  digitPrefix: string;
  tokenStart: number;
  caret: number;
};

/**
 * If the text before `caret` on the current line ends with `CCC:` or `CCC:digits`
 * (optional leading break), return token range for replacement.
 */
export function getTeamColonCompletionState(value: string, caret: number): TeamColonCompletion | null {
  if (caret < 0) return null;
  const c = Math.min(caret, value.length);
  const lineStart = value.lastIndexOf("\n", c - 1) + 1;
  const before = value.slice(lineStart, c);
  const re = /(?:^|[\s,;])(([A-Za-z]{3}):(\d*))$/;
  const m = before.match(re);
  if (!m) return null;
  const full = m[1]!;
  const team = m[2]!.toUpperCase();
  const digitPrefix = m[3] ?? "";
  const tokenStart = lineStart + (before.length - full.length);
  return { lineStart, team, digitPrefix, tokenStart, caret: c };
}

function suggestionsFor(refs: string[], team: string, digitPrefix: string): string[] {
  const p = `${team}:`;
  const base = refs.filter((x) => x.toUpperCase().startsWith(p));
  if (!digitPrefix) return base;
  return base.filter((x) => x.slice(p.length).startsWith(digitPrefix));
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
 * Attach TEAM:`:` … autocomplete to a field. Safe to call multiple times (one popup per field).
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
  let lastState: TeamColonCompletion | null = null;
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

  function apply(ref: string): void {
    const st = lastState;
    if (!st) return;
    const v = el.value;
    const start = st.tokenStart;
    const end = st.caret;
    const next = v.slice(0, start) + ref + v.slice(end);
    el.value = next;
    const newCaret = start + ref.length;
    el.setSelectionRange(newCaret, newCaret);
    el.dispatchEvent(new Event("input", { bubbles: true }));
    close();
    el.focus();
  }

  async function openOrUpdate(): Promise<void> {
    const caret = el.selectionStart ?? el.value.length;
    const st = getTeamColonCompletionState(el.value, caret);
    if (!st) {
      close();
      return;
    }
    const refs = await ensureRefs();
    const list = suggestionsFor(refs, st.team, st.digitPrefix).slice(0, 48);
    if (list.length === 0) {
      close();
      return;
    }
    lastState = st;
    lastSuggestions = list;
    selIdx = 0;
    popup.replaceChildren();
    for (const ref of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "sticker-ref-ac__item";
      b.setAttribute("role", "option");
      b.textContent = ref;
      b.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        lastState = st;
        lastSuggestions = list;
        apply(ref);
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
    if (ke.key === "Enter" && !ke.shiftKey) {
      const ref = lastSuggestions[selIdx];
      if (ref) {
        ke.preventDefault();
        ke.stopImmediatePropagation();
        apply(ref);
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
