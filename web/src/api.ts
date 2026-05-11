import type {
  InventoryMetrics,
  ListStickerRow,
  PackOpenResponse,
  PaniniSnapshot,
  SessionSnapshot,
  StickerDetail,
  TeamAnalyticsRow,
  TradeResponse,
} from "./types";
import { stickerPathFromRef } from "./parseRefs";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly detail?: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** In dev, Vite proxies `/api` → FastAPI. Same-origin when UI is served by FastAPI. */
export function apiBase(): string {
  const env = import.meta.env.VITE_API_BASE;
  if (env !== undefined && env !== "") return env.replace(/\/$/, "");
  if (import.meta.env.DEV) return "/api";
  return "";
}

async function parseError(res: Response): Promise<string> {
  const t = await res.text();
  try {
    const j = JSON.parse(t) as { detail?: unknown };
    if (typeof j.detail === "string") return j.detail;
    if (Array.isArray(j.detail)) return JSON.stringify(j.detail);
  } catch {
    /* plain text */
  }
  return t || res.statusText;
}

export async function apiGetJson<T>(path: string): Promise<T> {
  const url = `${apiBase()}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url);
  if (!res.ok) {
    const detail = await parseError(res);
    throw new ApiError(detail, res.status, detail);
  }
  return res.json() as Promise<T>;
}

export async function apiGetText(path: string): Promise<string> {
  const url = `${apiBase()}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url);
  if (!res.ok) {
    const detail = await parseError(res);
    throw new ApiError(detail, res.status, detail);
  }
  return res.text();
}

export async function apiSendJson<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const url = `${apiBase()}${path.startsWith("/") ? path : `/${path}`}`;
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await parseError(res);
    throw new ApiError(detail, res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json() as Promise<T>;
  return (await res.text()) as T;
}

export function getMetrics(): Promise<InventoryMetrics> {
  return apiGetJson("/metrics");
}

export function getAnalytics(
  include = "most_repeated,most_completed_team,most_missing_team,most_duplicated_team,fwc_summary,team_shield_photo",
): Promise<Record<string, unknown>> {
  return apiGetJson(`/analytics?include=${encodeURIComponent(include)}`);
}

export function getAnalyticsTeams(): Promise<{ teams: TeamAnalyticsRow[] }> {
  return apiGetJson("/analytics/teams");
}

export function getStickerRefsCatalog(): Promise<{ refs: string[] }> {
  return apiGetJson("/catalog/sticker-refs");
}

export function getMissingList(): Promise<ListStickerRow[]> {
  return apiGetJson("/lists/missing?format=json");
}

export function getDuplicatesList(): Promise<ListStickerRow[]> {
  return apiGetJson("/lists/duplicates?format=json");
}

export function getMissingCompact(): Promise<string> {
  return apiGetText("/lists/missing?format=compact");
}

export function getDuplicatesCompact(): Promise<string> {
  return apiGetText("/lists/duplicates?format=compact");
}

export function getStickerByRef(ref: string): Promise<StickerDetail> {
  return apiGetJson(stickerPathFromRef(ref));
}

export function addSticker(ref: string, count: number): Promise<unknown> {
  return apiSendJson("POST", "/stickers/add", { ref, count });
}

export function removeSticker(ref: string, count: number): Promise<unknown> {
  return apiSendJson("POST", "/stickers/remove", { ref, count });
}

export function openPack(stickers: string[], perPack: number): Promise<PackOpenResponse> {
  return apiSendJson("POST", "/packs/open", { stickers, per_pack: perPack });
}

export function executeTrade(
  give: string[],
  take: string[],
  strict_duplicates_only: boolean,
  allow_uneven: boolean,
): Promise<TradeResponse> {
  return apiSendJson("POST", "/trades", {
    give,
    take,
    strict_duplicates_only,
    allow_uneven,
  });
}

export function undoTrade(give: string[], take: string[]): Promise<TradeResponse> {
  return apiSendJson("POST", "/trades/undo", { give, take });
}

export function getSnapshot(): Promise<PaniniSnapshot> {
  return apiGetJson("/snapshot");
}

export function importSnapshot(
  body: PaniniSnapshot | Record<string, unknown>,
  applySession: boolean,
): Promise<unknown> {
  const q = applySession ? "?apply_session=true" : "?apply_session=false";
  return apiSendJson("POST", `/snapshot/import${q}`, body);
}

export function patchSession(partial: Partial<SessionSnapshot>): Promise<unknown> {
  return apiSendJson("PATCH", "/session", partial);
}

export function listsPrintUrl(): string {
  return `${apiBase()}/lists/print`;
}
