import { z } from 'zod'

/**
 * Every account belongs to the university, whether it registers itself with the
 * invite code or is created for someone by an admin. One definition, so the two
 * doors can't drift apart on what counts as a Rutgers address.
 *
 * Lowercased on the way in, for the same reason a NetID is: the case a student
 * happened to type is not part of who they are, and storing it means every lookup
 * has to remember to ignore it. They all do today — registration, both sign-ins and
 * the reset all match with `mode: 'insensitive'` — but that is four places agreeing
 * by hand, and a student asking why `Zas57` did not get their reset email is what it
 * costs to re-confirm that they still agree. Normalising here makes the question
 * unaskable.
 *
 * It also fixes a smaller thing outright: the domain check below is case-sensitive,
 * so before this an address typed as `abc123@RUTGERS.EDU` was turned away at
 * registration as though it were not a Rutgers address at all.
 */
export const rutgersEmail = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .refine((v) => v.split('@')[1]?.endsWith('rutgers.edu'), {
    message: 'Must be a rutgers.edu email address',
  })

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

/**
 * A person's name on an account.
 *
 * Trimmed before the length check, not after: `z.string().min(1)` is satisfied by
 * three spaces, so without the trim an account could be created whose name renders
 * as nothing at all. Both doors that create a professor — self-registration and an
 * admin creating one — share this for the same reason they share the email rule.
 */
export const personName = z.string().trim().min(1, 'Enter a name')
