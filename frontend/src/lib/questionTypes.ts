/**
 * The question types, once.
 *
 * This list lived in two places that had to agree and didn't quite: the add-question
 * dialog's `<select>` and the header chip's label map. The select said "Structure
 * drawing" and "Rating (1–5)" where the chip said "Structure" and "Rating".
 */
export const QUESTION_TYPES = [
  { value: 'FREE_TEXT', label: 'Free text' },
  { value: 'MULTIPLE_CHOICE', label: 'Multiple choice' },
  { value: 'MULTI_SELECT', label: 'Multi-select' },
  { value: 'ORDERING', label: 'Ordering' },
  { value: 'NUMERIC', label: 'Numeric' },
  { value: 'BLANKS', label: 'Fill in the blanks' },
  { value: 'STRUCTURE', label: 'Structure', hint: 'drawing' },
  { value: 'RATING', label: 'Rating', hint: '1–5' },
  { value: 'YES_NO', label: 'Yes / No' },
] as const

export type QuestionTypeValue = typeof QUESTION_TYPES[number]['value']

/** Types whose answers are chosen from a professor-authored list. */
export const OPTION_TYPES: readonly string[] = ['MULTIPLE_CHOICE', 'MULTI_SELECT', 'ORDERING']

export function hasOptions(type: string): boolean {
  return OPTION_TYPES.includes(type)
}

/** Terse name, for chips and headings. */
export function questionTypeLabel(type: string): string {
  return QUESTION_TYPES.find((t) => t.value === type)?.label ?? type
}

/** Fuller name, for a picker where the choice is still being made. */
export function questionTypeChoiceLabel(type: typeof QUESTION_TYPES[number]): string {
  return 'hint' in type && type.hint ? `${type.label} (${type.hint})` : type.label
}

/**
 * A stored answer as a person reads it. Multi-select, ordering and blanks answers are
 * stored as JSON arrays, which is what the grade views were printing.
 */
export function readableAnswer(type: string, text: string): string {
  if (type !== 'MULTI_SELECT' && type !== 'ORDERING' && type !== 'BLANKS') return text
  let arr: unknown
  try { arr = JSON.parse(text) } catch { return text }
  if (!Array.isArray(arr)) return text
  if (type === 'ORDERING') return arr.join(' → ')
  if (type === 'BLANKS') return arr.map((a, i) => `${i + 1}. ${String(a).trim() || '—'}`).join('  ·  ')
  return arr.join(', ')
}
