import { AppError } from '../middleware/error.middleware.js'

/**
 * Generate a unique code by calling `gen()` until `exists()` returns false.
 *
 * @param gen        Function that produces a candidate code string
 * @param exists     Async predicate — returns true if the code is already taken
 * @param maxAttempts  Throw after this many failed attempts (default 15)
 * @param excluded   Optional Set of codes reserved within the current batch;
 *                   matching codes are skipped and the generated code is added
 *                   to the set automatically (used during bulk duplication)
 */
export async function generateUniqueCode(
  gen: () => string,
  exists: (code: string) => Promise<boolean>,
  maxAttempts = 15,
  excluded?: Set<string>
): Promise<string> {
  let code: string
  let attempts = 0
  do {
    code = gen()
    attempts++
    if (attempts > maxAttempts) throw new AppError('Failed to generate unique code', 500)
  } while ((excluded?.has(code) ?? false) || await exists(code))
  excluded?.add(code)
  return code
}
