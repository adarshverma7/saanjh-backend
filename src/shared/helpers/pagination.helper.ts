export interface CursorPayload {
  recordedAt: Date;
  id: string;
}

export interface StarredCursorPayload {
  starredAt: Date;
  id: string;
}

// ── Cursor encoding / decoding ─────────────────────────────────────────────

/**
 * Encodes a (recorded_at, id) pair into a URL-safe base64 cursor string.
 * Cursor-based pagination is preferred over offset because:
 *   1. Stable results when new entries are inserted
 *   2. No performance degradation at large offsets
 */
export function encodeCursor(recordedAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ t: recordedAt.toISOString(), i: id }),
  ).toString('base64url');
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const { t, i } = JSON.parse(decoded) as { t: string; i: string };
    const recordedAt = new Date(t);
    if (isNaN(recordedAt.getTime())) return null;
    return { recordedAt, id: i };
  } catch {
    return null;
  }
}

/**
 * Encodes a (starred_at, id) pair for Memory Jar pagination.
 */
export function encodeStarredCursor(starredAt: Date, id: string): string {
  return Buffer.from(
    JSON.stringify({ s: starredAt.toISOString(), i: id }),
  ).toString('base64url');
}

export function decodeStarredCursor(cursor: string): StarredCursorPayload | null {
  try {
    const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
    const { s, i } = JSON.parse(decoded) as { s: string; i: string };
    const starredAt = new Date(s);
    if (isNaN(starredAt.getTime())) return null;
    return { starredAt, id: i };
  } catch {
    return null;
  }
}

// ── Cursor WHERE fragments ──────────────────────────────────────────────────

/**
 * Returns a parameterised WHERE fragment for cursor-based pagination
 * sorted by (recorded_at DESC, id DESC).
 *
 * Usage:
 *   const { sql, params } = buildCursorWhere(cursor, existingParams.length)
 *   query += sql ? ` AND ${sql}` : ''
 *   params.push(...params)
 */
export function buildCursorWhere(
  cursor: string | undefined,
  paramOffset = 0,
): { sql: string; values: unknown[] } {
  if (!cursor) return { sql: '', values: [] };

  const payload = decodeCursor(cursor);
  if (!payload) return { sql: '', values: [] };

  const p1 = paramOffset + 1;
  const p2 = paramOffset + 2;

  return {
    sql: `(recorded_at < $${p1} OR (recorded_at = $${p1} AND id < $${p2}))`,
    values: [payload.recordedAt, payload.id],
  };
}

/**
 * Returns a WHERE fragment for starred_at DESC pagination (Memory Jar).
 */
export function buildStarredCursorWhere(
  cursor: string | undefined,
  paramOffset = 0,
): { sql: string; values: unknown[] } {
  if (!cursor) return { sql: '', values: [] };

  const payload = decodeStarredCursor(cursor);
  if (!payload) return { sql: '', values: [] };

  const p1 = paramOffset + 1;
  const p2 = paramOffset + 2;

  return {
    sql: `(starred_at < $${p1} OR (starred_at = $${p1} AND id < $${p2}))`,
    values: [payload.starredAt, payload.id],
  };
}

// ── Page result type ───────────────────────────────────────────────────────

export interface PageResult<T> {
  items: T[];
  next_cursor: string | null;
  has_more: boolean;
}

/**
 * Slices a fetched-one-extra result set and builds the PageResult.
 * Pattern: fetch limit+1 rows → if result.length > limit, there are more pages.
 */
export function buildPageResult<T extends { recorded_at?: Date; id: string }>(
  rows: T[],
  limit: number,
): PageResult<T> {
  const has_more = rows.length > limit;
  const items = has_more ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const next_cursor =
    has_more && last?.recorded_at
      ? encodeCursor(last.recorded_at, last.id)
      : null;

  return { items, next_cursor, has_more };
}
