/** Internal canonical ref string: TEAM:slot or FWC:internalSlot (20 = album 00). */
function formatCanonical(catU: string, slotRaw: string): string {
  const cat = catU.toUpperCase();
  const slot = slotRaw.trim();
  if (cat === "FWC") {
    if (/^0+$/.test(slot) || slot === "00" || slot === "0") return "FWC:20";
    const n = parseInt(slot, 10);
    if (Number.isNaN(n)) throw new Error(`Invalid FWC slot: ${slotRaw}`);
    if (n >= 1 && n <= 19) return `FWC:${n}`;
    if (n === 20) return "FWC:20";
    throw new Error("FWC slot must be 00/1–20");
  }
  if (/[A-Za-z]/.test(slot)) {
    throw new Error(
      `Invalid team slot "${slotRaw}" — use digits only (1–20), one sticker per line.`,
    );
  }
  const n = parseInt(slot.trim(), 10);
  if (Number.isNaN(n) || n < 1 || n > 20) throw new Error(`Invalid team slot: ${slotRaw}`);
  return `${cat}:${n}`;
}

/**
 * Accepts `CAT:SLOT`, `CAT: SLOT`, `CAT  SLOT` (space, no colon), optional spaces.
 * Examples: `MEX:5`, `FWC 14`, `RSA 7`, `FWC:00`, `fwc: 12`.
 */
export function normalizeStickerRef(raw: string): string {
  let s = raw.trim().replace(/\s+/g, " ");
  if (!s) throw new Error("Empty ref");

  /** Album sticker printed as "00" only (no FWC prefix on the physical sticker). */
  if (/^0+$/.test(s)) {
    return "FWC:20";
  }

  const colonIdx = s.indexOf(":");
  if (colonIdx !== -1) {
    const cat = s.slice(0, colonIdx).trim();
    const slotRaw = s.slice(colonIdx + 1).trim();
    if (!cat) throw new Error("Missing category");
    return formatCanonical(cat, slotRaw);
  }

  const m = s.match(/^([A-Za-z]{3})\s+(.+)$/);
  if (m) {
    return formatCanonical(m[1]!, m[2]!);
  }

  throw new Error(`Use CATEGORY:SLOT or TEAM SLOT (e.g. MEX:5 or FWC 14), got: ${raw}`);
}

/**
 * One logical line may expand to several refs:
 * - `MEX: 1, 2, 3` → MEX:1, MEX:2, MEX:3
 * - `FWC 1, 2` → FWC:1, FWC:2
 * - `RSA 7` → RSA:7
 */
export function expandRefsFromLine(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const colonIdx = trimmed.indexOf(":");
  if (colonIdx !== -1) {
    const cat = trimmed.slice(0, colonIdx).trim();
    const after = trimmed.slice(colonIdx + 1).trim();
    if (after.includes(",")) {
      const slots = after
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
      return slots.map((slot) => formatCanonical(cat, slot));
    }
  }

  const spaceComma = trimmed.match(/^([A-Za-z]{3})\s+(.+)$/);
  if (spaceComma && spaceComma[2]!.includes(",")) {
    const cat = spaceComma[1]!;
    const slots = spaceComma[2]!
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    return slots.map((slot) => normalizeStickerRef(`${cat} ${slot}`));
  }

  return [normalizeStickerRef(trimmed)];
}

/** HTTP path for GET /stickers/{cat}/{slot} from a user ref. */
export function stickerPathFromRef(ref: string): string {
  const norm = normalizeStickerRef(ref);
  const idx = norm.indexOf(":");
  const cat = norm.slice(0, idx);
  const slotRaw = norm.slice(idx + 1);

  if (cat === "FWC") {
    if (/^0+$/.test(slotRaw) || slotRaw === "00" || slotRaw === "0") {
      return "/stickers/FWC/00";
    }
    const n = parseInt(slotRaw, 10);
    if (Number.isNaN(n)) throw new Error("Invalid FWC slot");
    if (n >= 1 && n <= 19) return `/stickers/FWC/${n}`;
    if (n === 20) return `/stickers/FWC/20`;
    throw new Error("FWC slot must be 00/1–20");
  }

  const n = parseInt(slotRaw, 10);
  if (Number.isNaN(n) || n < 1 || n > 20) throw new Error("Team slot must be 1–20");
  return `/stickers/${cat}/${n}`;
}

/** Split textarea lines (`\r\n`, `\n`, lone `\r` — e.g. Excel / Windows). */
export function splitInputLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Plain refs from textarea: non-empty lines, comma lists expanded. */
export function parseRefLines(text: string): string[] {
  const out: string[] = [];
  const lines = splitInputLines(text);
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i]!;
    try {
      out.push(...expandRefsFromLine(t));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Line ${i + 1}: ${msg}`);
    }
  }
  return out;
}

function splitBatchLine(trimmed: string): { body: string; count: number } {
  const tabParts = trimmed.split(/\t/);
  if (tabParts.length >= 2 && /^\d+$/.test(tabParts[tabParts.length - 1]!.trim())) {
    return {
      body: tabParts.slice(0, -1).join("\t").trim(),
      count: parseInt(tabParts[tabParts.length - 1]!.trim(), 10),
    };
  }

  const hasComma = trimmed.includes(",");

  const xMatch = trimmed.match(/^(.+?)\s+[x×]\s*(\d+)$/i);
  if (xMatch) {
    return { body: xMatch[1]!.trim(), count: parseInt(xMatch[2]!, 10) };
  }

  if (!hasComma) {
    const tailMatch = trimmed.match(/^(.+?)\s+(\d+)$/);
    if (tailMatch && (tailMatch[1]!.includes(":") || /^[A-Za-z]{3}\s+\S/.test(tailMatch[1]!))) {
      return { body: tailMatch[1]!.trim(), count: parseInt(tailMatch[2]!, 10) };
    }
  }

  return { body: trimmed, count: 1 };
}

/** Batch lines: `REF`, `FWC 14`, `MEX: 1, 2, 3`, `REF x3`, optional counts. */
export function parseBatchStickerLines(text: string): { ref: string; count: number }[] {
  const out: { ref: string; count: number }[] = [];
  const lines = splitInputLines(text);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!;
    const { body, count } = splitBatchLine(trimmed);
    if (count < 1) continue;
    let expanded: string[];
    try {
      expanded = expandRefsFromLine(body);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Line ${i + 1}: ${msg}`);
    }
    for (const ref of expanded) {
      out.push({ ref, count });
    }
  }
  return out;
}

export function totalBatchCount(rows: { ref: string; count: number }[]): number {
  return rows.reduce((a, r) => a + r.count, 0);
}

/** Normalize ref for comparison with API `ref` fields (e.g. FWC:00 → FWC:20). */
export function canonicalRef(ref: string): string {
  return normalizeStickerRef(ref);
}
