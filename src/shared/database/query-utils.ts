/**
 * TypeORM's DataSource.query() returns the rows array directly for INSERT and
 * SELECT (including INSERT ... ON CONFLICT), but a `[rows, affectedCount]` tuple
 * for a plain UPDATE or DELETE ... RETURNING. Reading `result[0]` on the tuple
 * therefore yields the rows array rather than the first row, and `result.length`
 * is always 2 regardless of how many rows matched.
 *
 * `returningRows` normalises both shapes to a plain rows array so callers can
 * safely use `rows[0]` and `rows.length`.
 */
export function returningRows<T>(result: unknown): T[] {
  return Array.isArray(result) && Array.isArray(result[0])
    ? (result[0] as T[])
    : ((result ?? []) as T[]);
}
