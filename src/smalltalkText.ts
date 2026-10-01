/**
 * Text for Smalltalk source. A leaf module, so the session and the query
 * builders can share it without importing each other.
 */

/** Escape a string for inclusion in a Smalltalk string literal. */
export function escapeString(value: string): string {
  return value.replace(/'/g, "''");
}
