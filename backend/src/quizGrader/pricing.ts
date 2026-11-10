/**
 * $ per million tokens (input, output), to report what grading cost. Update from the
 * pricing page if these move; a model not listed is reported as unpriced, not as free.
 */
export const PRICES: Record<string, [number, number]> = {
  'claude-haiku-5-5': [0.1, 0.5],
  'claude-sonnet-5-5': [2, 10],
  'claude-opus-5-5': [4, 20],
  'claude-haiku-4-5': [1, 5],
}

interface Usage { model: string; input_tokens: number; output_tokens: number; cached?: boolean }

/** What these calls cost when first made (a cached re-run is not billed again). */
export function costOf(usage: Usage[]): { dollars: number; unpriced: string[] } {
  let dollars = 0
  const unpriced = new Set<string>()
  for (const u of usage) {
    const p = PRICES[u.model]
    if (!p) { unpriced.add(u.model); continue }
    dollars += (u.input_tokens * p[0] + u.output_tokens * p[1]) / 1e6
  }
  return { dollars, unpriced: [...unpriced] }
}
