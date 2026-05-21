/** Album print order (matches `panini_service.album_pages` / WM26 contents index). */

import { canonicalRef } from "./parseRefs";

const FWC = "FWC";

/** Same order as `scripts/panini_catalog.TEAM_CODES`. */
export const TEAM_CODES: readonly string[] = [
  "MEX", "RSA", "KOR", "CZE", "CAN", "BIH", "QAT", "SUI", "BRA", "MAR", "HAI", "SCO",
  "USA", "PAR", "AUS", "TUR", "GER", "CUW", "CIV", "ECU", "NED", "JPN", "SWE", "TUN",
  "BEL", "EGY", "IRN", "NZL", "ESP", "CPV", "KSA", "URU", "FRA", "SEN", "IRQ", "NOR",
  "ARG", "ALG", "AUT", "JOR", "POR", "COD", "UZB", "COL", "ENG", "CRO", "GHA", "PAN",
];

const TEAM_START_PAGE = [
  8, 10, 12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38, 40, 42, 44, 46, 48, 50,
  52, 54, 58, 60, 62, 64, 66, 68, 70, 72, 74, 76, 78, 80, 82, 84, 86, 88, 90, 92, 94, 96,
  98, 100, 102, 104,
];

const teamIndex = new Map(TEAM_CODES.map((c, i) => [c, i]));

function fwcPrintedPage(internalSlot: number): number {
  if (internalSlot === 20) return 0;
  if (internalSlot >= 1 && internalSlot <= 4) return 1;
  if (internalSlot >= 5 && internalSlot <= 6) return 2;
  if (internalSlot >= 7 && internalSlot <= 8) return 3;
  if (internalSlot >= 9 && internalSlot <= 10) return 106;
  if (internalSlot >= 11 && internalSlot <= 13) return 107;
  if (internalSlot >= 14 && internalSlot <= 15) return 108;
  if (internalSlot >= 16 && internalSlot <= 19) return 109;
  return 9999;
}

function teamPrintedPage(cat: string, slot: number): number {
  const start = TEAM_START_PAGE[teamIndex.get(cat) ?? -1];
  if (start === undefined) return 9999;
  if (slot >= 1 && slot <= 10) return start;
  if (slot >= 11 && slot <= 20) return start + 1;
  return 9999;
}

export type AlbumOrderHint = {
  category_code: string;
  slot_code: string;
  album_printed_page?: number;
};

function parseRefParts(ref: string): { cat: string; slot: number } | null {
  const c = canonicalRef(ref);
  const i = c.indexOf(":");
  if (i < 0) return null;
  const cat = c.slice(0, i);
  const slot = parseInt(c.slice(i + 1), 10);
  if (Number.isNaN(slot)) return null;
  return { cat, slot };
}

/** Sort key: printed page, team index, slot (album order). */
export function albumOrderKey(ref: string, hint?: AlbumOrderHint | null): [number, number, number] {
  if (hint?.album_printed_page != null && hint.album_printed_page >= 0) {
    const ti = teamIndex.get(hint.category_code.toUpperCase()) ?? 999;
    const slot = parseInt(hint.slot_code, 10) || 0;
    return [hint.album_printed_page, ti, slot];
  }
  const p = parseRefParts(ref);
  if (!p) return [99999, 99999, 99999];
  const cat = p.cat.toUpperCase();
  if (cat === FWC) return [fwcPrintedPage(p.slot), 0, p.slot];
  const ti = teamIndex.get(cat) ?? 999;
  const page = teamPrintedPage(cat, p.slot);
  return [page, ti, p.slot];
}

export function compareRefsByAlbumOrder(a: string, b: string, hints?: Map<string, AlbumOrderHint>): number {
  const ha = hints?.get(canonicalRef(a));
  const hb = hints?.get(canonicalRef(b));
  const ka = albumOrderKey(a, ha);
  const kb = albumOrderKey(b, hb);
  for (let i = 0; i < 3; i++) {
    if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
  }
  return 0;
}

export function sortRefsByAlbumOrder(refs: string[], hints?: Map<string, AlbumOrderHint>): string[] {
  return [...refs].sort((a, b) => compareRefsByAlbumOrder(a, b, hints));
}

/** Sort team codes in album order (for compact `TEAM: 1, 2, 3` lines). */
export function sortTeamCodes(cats: string[]): string[] {
  return [...cats].sort((a, b) => {
    if (a === FWC) return -1;
    if (b === FWC) return 1;
    return (teamIndex.get(a) ?? 999) - (teamIndex.get(b) ?? 999);
  });
}

export function compareRefsAlphabetically(a: string, b: string): number {
  return canonicalRef(a).localeCompare(canonicalRef(b));
}
