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
