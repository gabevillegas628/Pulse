// ─── Textbook helpers ─────────────────────────────────────────────────────────
// Pure functions — all repo config comes from the Class record (per-class).

/** GitHub Contents API URL for listing files in the textbook folder. */
export function contentsApiUrl(repo: string, path: string): string {
  const segment = path ? `/${path}` : ''
  return `https://api.github.com/repos/${repo}/contents${segment}`
}

/** Convert a filename like "ch01-introduction-to-organic-chemistry.md"
 *  or "01_thermodynamics.md" into a human-readable title. */
export function filenameToTitle(filename: string): string {
  let name = filename.replace(/\.md$/i, '')
  // Strip leading chapter number + separator (e.g. "ch01-", "01_", "1.")
  name = name.replace(/^(ch\d+[-_.]|\d+[-_.])/i, '')
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Extract the sort key from a filename (the leading number). */
export function chapterSortKey(filename: string): number {
  const match = filename.match(/^(?:ch)?(\d+)/i)
  return match ? parseInt(match[1], 10) : 9999
}
