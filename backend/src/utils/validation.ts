import { z } from 'zod'

/**
 * Every account belongs to the university, whether it registers itself with the
 * invite code or is created for someone by an admin. One definition, so the two
 * doors can't drift apart on what counts as a Rutgers address.
 */
export const rutgersEmail = z.string().email().refine(
  (v) => v.split('@')[1]?.endsWith('rutgers.edu'),
  { message: 'Must be a rutgers.edu email address' }
)

/**
 * A NetID: letters then digits, nothing else.
 *
 * Checked against every NetID that appeared in a 140-seat lecture's logs — 50 of 51
 * matched, and the one that did not was a student's full email address sitting in the
 * column. A name lands in the same trap: it is all letters, so it fails the digits
 * requirement rather than becoming an account nobody can sign into.
 *
 * Lowercased on the way in because a NetID is case-insensitive everywhere a human
 * meets it, and the sign-in throttle already keys on the lowercased form. Storing the
 * case a student happened to type is what let `SK2997` miss the row for `sk2997`
 * while still spending that account's ten attempts.
 */
export const netId = z
  .string()
  .trim()
  .toLowerCase()
  .regex(
    /^[a-z]{1,8}[0-9]{1,6}$/,
    'A NetID is letters followed by numbers, like abc123 — no spaces, punctuation, or full email addresses'
  )
