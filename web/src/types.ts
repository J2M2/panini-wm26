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

/** GET /metrics */
export interface InventoryMetrics {
  album_unique_slots: number;
  total_physical_stickers: number;
  unique_slots_filled: number;
  unique_slots_missing: number;
  pct_complete_unique: number;
  spare_copies: number;
  slots_with_duplicates: number;
  session: SessionSnapshot;
}

/** GET /stickers/... */
export interface StickerDetail {
  id: number;
  category_code: string;
  slot_code: string;
  role: StickerRole;
  qty: number;
  spare_copies: number;
  ref: string;
  status: string;
  album_code?: string;
  /** Space-separated form for notes / spreadsheets (e.g. `MEX 5`, `FWC 14`). */
  album_paste_line?: string;
  /** Where this sticker sits in the physical album (approximate for teams). */
  album_location?: string;
  /** Printed album page number from the WM26 contents index (manual). */
  album_printed_page?: number;
  /** Contents index group A-L; null/omitted for FWC. */
  album_index_group?: string | null;
  /** 1-based team index in album order (same as TEAM_CODES); null for FWC. */
  album_team_ordinal?: number | null;
}

export interface ListStickerRow {
  category_code: string;
  slot_code: string;
  role: StickerRole;
  qty: number;
  ref: string;
  album_code?: string;
  spare_copies?: number;
  /** Printed album page from WM26 index. */
  album_printed_page?: number;
  /** Contents index group A-L; omitted for FWC. */
  album_index_group?: string | null;
  /** Single-line tooltip for list rows. */
  album_hover_hint?: string;
}

export interface TradeResponse {
  warnings: string[];
  gave: { ref: string; qty_before: number; qty_after: number }[];
  received: { ref: string; qty_before: number; qty_after: number }[];
}

export interface PackOpenResponse {
  per_pack: number;
  added_as_new: Record<string, unknown>[];
  added_as_duplicate: Record<string, unknown>[];
  warnings: string[];
}

/** GET /analytics/teams — one row per national team page. */
export interface TeamAnalyticsRow {
  code: string;
  slots_with_copy: number;
  slots_missing: number;
  slots_total: number;
  pct_complete: number;
  shield_ok: boolean;
  team_photo_ok: boolean;
}
