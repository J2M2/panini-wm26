/**
 * Mirrors Python export (`scripts/export_json.py`) for WM26 Panini tracker.
 * `slot_code`: team "1"–"20". FWC also "1"–"20" in the DB; **slot "20"** is the
 * physical sticker printed as **00** only (`role` === "fwc_special"). Use
 * `album_code` on FWC rows for display when present (schema_version >= 2).
 */

export type CategoryKind = "fwc" | "team";

export interface Category {
  code: string;
  kind: CategoryKind;
  name: string | null;
}

export type StickerRole =
  | "shield"
  | "team_photo"
  | "fwc_special"
  | "fwc"
  | null;

export interface StickerInventory {
  id: number;
  category_code: string;
  slot_code: string;
  role: StickerRole;
  qty: number;
  /** FWC only: printed album code; slot "20" maps to "00". */
  album_code?: string;
}

export interface SessionSnapshot {
  packs_opened: number;
  traded_out_count: number;
  traded_in_count: number;
}

export interface PaniniSnapshot {
  exported_at: string;
  schema_version: number;
  categories: Category[];
  stickers: StickerInventory[];
  /** Present from schema v3 export; optional on import. */
  session?: SessionSnapshot;
}
