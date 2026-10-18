/**
 * Fill-in-the-blank matching, shared so the gradebook and the screens cannot disagree.
 *
 * A BLANKS question carries its prompts in `options`, its key in `correctAnswer` as a JSON
 * `string[]` (one entry per prompt, alternatives separated by "/"), and each answer in
 * `responseText` as a JSON `string[]` of the same length.
 *
 * Matching is lenient on purpose. These questions gauge whether the room is with the
 * lecture, not whether anyone can spell "triquetrum", and most of the grade is effort that
 * the professor overrides by hand anyway. So "close" counts: case, punctuation, accents,
 * spacing, small words and a trailing plural are ignored, a typo or two is forgiven in
 * proportion to the word's length, word order does not matter, generic nouns like "end"
 * or "fossa" may be left off, and words around the answer are allowed.
 *
 * The cost of that is knowable and accepted: two different terms spelled almost alike
 * (ilium and ileum) will match each other.
 */

/** Separates accepted alternatives within one blank's key: "triquetrum / triquetral". */
export const BLANK_ALTERNATIVE_SEPARATOR = '/'

/** Longest answer a student may give to a single blank. */
export const BLANK_ANSWER_MAX = 200

/** Most prompts a single question may carry; past this it is a worksheet, not a check. */
export const BLANKS_MAX = 10

/** Words that carry no answer: "the scaphoid", "supraspinous, infraspinous and subscapular". */
const FILLER = new Set(['the', 'a', 'an', 'of', 'and', 'or', 'in', 'on', 'at', 'to', 'it', 'its', 'is', 'with'])

/**
 * Generic structural nouns: the part of a term that says what kind of thing it is, not
 * which one. A student who writes "acromial" for "acromial end", or "olecranon" for
 * "olecranon fossa", has named it; one who writes only "fossa" has not.
 *
 * They are optional in an answer but not ignored. An answer naming a *different* kind of
 * thing ("olecranon process" for "olecranon fossa", "greater tuberosity" for "greater
 * tubercle") is a different structure, and is refused. Anatomy-flavoured because that is
 * where the type is used first; extend it as other subjects need.
 */
const HEADS = [
  'end', 'part', 'side', 'area', 'region', 'portion', 'structure', 'surface', 'border',
  'margin', 'bone', 'cavity', 'fossa', 'process', 'notch', 'groove', 'tubercle',
  'tuberosity', 'facet', 'foramen', 'canal', 'ridge', 'crest', 'line', 'head', 'neck',
  'body', 'shaft', 'angle', 'spine',
]

/** Within one letter of a generic noun, so "fossae" and "processes" still count as one. */
function isHead(w: string): boolean {
  return HEADS.some((h) => editDistance(w, h) <= (h.length >= 5 ? 1 : 0))
}

function words(s: string): string[] {
  const raw = s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
  // Single letters beside other words are debris from apostrophes: "it's" → "it s". On
  // their own they are the answer ("C", "B"), so they stay.
  const hasLonger = raw.some((w) => w.length > 1)
  return raw
    .filter((w) => w.length > 1 || /\d/.test(w) || !hasLonger)
    // A plural is the same answer. Only past three letters, so "gas" and "has" survive.
    .map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
    .filter((w) => !FILLER.has(w))
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    prev = cur
  }
  return prev[b.length]
}

/** Typos forgiven for a key of `n` letters. Nothing on very short words, where one letter is a different word. */
function allowance(n: number): number {
  if (n < 4) return 0
  if (n < 6) return 1
  if (n < 10) return 2
  return Math.floor(n / 5)
}

const close = (a: string, k: string) => editDistance(a, k) <= allowance(k.length)

/**
 * Whether `answer` is close enough to one accepted spelling of the key.
 *
 * Word by word, in any order: every word of the key that names something must turn up in
 * the answer, give or take a typo, so a list of three fossae counts in whatever order
 * the student remembered them. Generic nouns ("end", "fossa") may be left out but not
 * swapped for a different one. Surrounding words are allowed — "it's the olecranon fossa
 * of the humerus" — up to a point: an answer carrying more stray terms than the key has
 * real ones is a list of guesses, and listing every carpal does not name the scaphoid.
 */
function matchesOne(answer: string, key: string): boolean {
  const k = words(key)
  if (k.length === 0) return false
  const a = words(answer)
  if (a.length === 0) return false

  // Compared with the spaces out, so "semi lunar", "semi-lunar" and "semilunar" agree.
  if (close(a.join(''), k.join(''))) return true

  const keyHeads = k.filter(isHead)
  const named = k.filter((w) => !isHead(w))
  // A key that is nothing but a generic noun ("spine") has to be given as written.
  const needed = named.length > 0 ? named : k

  const unused = [...a]
  for (const w of needed) {
    const i = unused.findIndex((u) => close(u, w))
    if (i < 0) return false
    unused.splice(i, 1)
  }

  // What is left: generic nouns the key also has are fine, a different one is not.
  const strays = unused.filter((u) => !keyHeads.some((h) => close(u, h)))
  if (keyHeads.length > 0 && strays.some(isHead)) return false
  return strays.filter((u) => !isHead(u)).length <= needed.length + 1
}

/** The alternatives one key entry accepts, empty when the blank has no key. */
export function blankAlternatives(keyEntry: string | null | undefined): string[] {
  if (!keyEntry) return []
  return keyEntry
    .split(BLANK_ALTERNATIVE_SEPARATOR)
    .map((s) => s.trim())
    .filter(Boolean)
}

/** Whether an answer to one blank matches its key entry. null when the blank has no key. */
export function blankMatches(answer: string, keyEntry: string | null | undefined): boolean | null {
  const alts = blankAlternatives(keyEntry)
  if (alts.length === 0) return null
  if (!answer.trim()) return false
  return alts.some((alt) => matchesOne(answer, alt))
}

/** Parse a stored JSON string array, tolerating the malformed and the absent alike. */
export function parseBlankList(stored: string | null | undefined): string[] {
  if (!stored) return []
  try {
    const arr = JSON.parse(stored)
    return Array.isArray(arr) ? arr.map((v) => (typeof v === 'string' ? v : '')) : []
  } catch {
    return []
  }
}

/** Per-blank verdicts for one answer: true close, false not, null where the blank has no key. */
export function blankVerdicts(
  responseText: string,
  correctAnswer: string | null,
  count: number,
): Array<boolean | null> {
  const answers = parseBlankList(responseText)
  const key = parseBlankList(correctAnswer)
  return Array.from({ length: count }, (_, i) => blankMatches(answers[i] ?? '', key[i]))
}

/**
 * A 0–1 score for one answer, averaged over the blanks.
 *
 * Each blank earns 1 when close, 0.5 for a genuine attempt that is not, and 0 when left
 * empty, the same stance multiple choice takes on a wrong answer. A blank with no key
 * earns 1 for any attempt: there is nothing to be wrong against.
 */
export function blanksScore(responseText: string, correctAnswer: string | null, count: number): number {
  const answers = parseBlankList(responseText)
  const n = count || answers.length
  if (n === 0) return 0
  const verdicts = blankVerdicts(responseText, correctAnswer, n)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const attempted = !!answers[i]?.trim()
    if (!attempted) continue
    const v = verdicts[i]
    sum += v === false ? 0.5 : 1
  }
  return sum / n
}
