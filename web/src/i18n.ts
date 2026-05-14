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
