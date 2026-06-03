/**
 * Cursor pagination helpers. Cursor is base64url of { s: sortValue, id: tiebreak }.
 */
export interface DecodedCursor {
  s: number;
  id: string;
}

export interface PageMeta {
  limit: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export function encodeCursor(c: DecodedCursor): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string | undefined): DecodedCursor | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as Partial<DecodedCursor>;
    if (typeof parsed.s !== 'number' || typeof parsed.id !== 'string') {
      return null;
    }
    return { s: parsed.s, id: parsed.id };
  } catch {
    return null;
  }
}

export function clampLimit(raw: unknown, def = 50, max = 100): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) return def;
  return Math.min(Math.floor(n), max);
}

/**
 * Given rows fetched with `limit + 1`, split off the extra and build page meta.
 */
export function buildPage<T extends { id: string }>(
  rows: T[],
  limit: number,
  sortValueOf: (row: T) => number,
): { items: T[]; pagination: PageMeta } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor =
    hasMore && last
      ? encodeCursor({ s: sortValueOf(last), id: last.id })
      : null;
  return { items, pagination: { limit, nextCursor, hasMore } };
}
