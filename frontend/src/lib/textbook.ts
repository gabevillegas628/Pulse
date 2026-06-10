// ─── Textbook helpers ─────────────────────────────────────────────────────────
// Pure functions — all repo config comes from the Class record (per-class).

/** GitHub Contents API URL for listing files in the textbook folder. */
export function contentsApiUrl(repo: string, path: string): string {
  const segment = path ? `/${path}` : ''
  return `https://api.github.com/repos/${repo}/contents${segment}`
}

/** Parse a chapter-list.md file into a stem→title map.
 *  Each non-empty line should be "filename-stem: Display Title". */
export function parseChapterList(text: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const line of text.split('\n')) {
    const match = line.match(/^([^:]+):\s*(.+)$/)
    if (match) map.set(match[1].trim(), match[2].trim())
  }
  return map
}

/** Convert a filename like "ch01-introduction-to-organic-chemistry.md"
 *  into a human-readable title, using an explicit title map when available. */
export function filenameToTitle(filename: string, titles?: Map<string, string>): string {
  const stem = filename.replace(/\.md$/i, '')
  if (titles?.has(stem)) return titles.get(stem)!
  // Fallback: derive from filename
  let name = stem.replace(/^(ch\d+[-_.]|\d+[-_.])/i, '')
  return name
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Extract the sort key from a filename (the leading number). */
export function chapterSortKey(filename: string): number {
  const match = filename.match(/^(?:ch)?(\d+)/i)
  return match ? parseInt(match[1], 10) : 9999
}
