import { SPANISH_BY_ENGLISH } from "./i18n-es";

export type Locale = "en" | "es";

const STORAGE_KEY = "panini_locale";

export function getLocale(): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "es" || v === "en") return v;
  } catch {
    /* storage blocked */
  }
  return "en";
}

export function setLocale(loc: Locale): void {
  try {
    localStorage.setItem(STORAGE_KEY, loc);
  } catch {
    /* ignore */
  }
  location.reload();
}

/** Localize a fixed English UI string (Spanish map falls back to English). */
export function tr(s: string): string {
  if (getLocale() !== "es") return s;
  return SPANISH_BY_ENGLISH[s] ?? s;
}

/** After `tr`, replace `{name}` placeholders (ASCII braces). */
export function trf(template: string, vars: Record<string, string | number>): string {
  let out = tr(template);
  for (const [k, v] of Object.entries(vars)) {
    out = out.replaceAll(`{${k}}`, String(v));
  }
  return out;
}

/** Localize tie notes from `GET /analytics` (English prefixes from the API). */
export function trTieNote(note: string): string {
  if (getLocale() !== "es" || !note) return note;
  const closest = note.match(/^Tied for closest: (.+)$/);
  if (closest) return trf("Tied for closest: {codes}", { codes: closest[1] });
  const missing = note.match(/^Tied for most missing: (.+)$/);
  if (missing) return trf("Tied for most missing: {codes}", { codes: missing[1] });
  const dupes = note.match(/^Tied for most duplicate copies: (.+)$/);
  if (dupes) return trf("Tied for most duplicate copies: {codes}", { codes: dupes[1] });
  return note;
}

/** Localize pack-outlook warnings returned by the API. */
export function trApiNote(note: string): string {
  if (getLocale() !== "es" || !note) return note;
  const truncated = note.match(
    /^Some trials exceeded max_packs \((\d+)\); increase the cap or lower trials — results may be biased low\.$/,
  );
  if (truncated) {
    return trf(
      "Some trials exceeded max_packs ({max}); increase the cap or lower trials — results may be biased low.",
      { max: truncated[1] },
    );
  }
  return note;
}
