import { Request, Response } from 'express'
import rateLimit, { ipKeyGenerator } from 'express-rate-limit'

/**
 * Login throttling, keyed on the account rather than the caller's address.
 *
 * An IP key is wrong for this app specifically. A lecture hall shares one NAT egress
 * address, so every student in the room hashes to a single bucket: the first ten to
 * sign in spend the budget and the rest are refused for fifteen minutes. That is not
 * hypothetical — it is what a 140-seat rollout hit, and it gets worse as the class
 * stops registering and starts logging in.
 *
 * The account is also the right key on the merits. What this guards against is
 * guessing one student's password, and guessing is bounded by the account under
 * attack, not by where the guesses come from. Ten wrong passwords for one netID is a
 * lockout worth having; ten students signing in from one lecture hall is a Tuesday.
 *
 * Only failures count, so a student signing in on a second device is never punished
 * for the first, and a whole room of correct passwords never trips anything.
 */
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    // Student login sends `credential` (netID or email); professor login sends `email`.
    const body = req.body as { credential?: unknown; email?: unknown } | undefined
    const claimed = typeof body?.credential === 'string' ? body.credential
      : typeof body?.email === 'string' ? body.email
      : null
    // No parseable account means the request is malformed and will fail validation
    // anyway. Fall back to the address so the route is never left wholly unguarded.
    // ipKeyGenerator, not req.ip: it normalises IPv6 to a subnet, so a client cannot
    // walk its own /64 to mint a fresh bucket per attempt.
    return claimed ? `acct:${claimed.trim().toLowerCase()}` : `ip:${ipKeyGenerator(req.ip ?? '')}`
  },
  // express-rate-limit answers the request itself, so a lockout never reaches the error
  // middleware and would otherwise be invisible. Counting how many people a lockout
  // actually hit was the first unanswerable question after the 140-seat rollout, so the
  // account is recorded: the log has to be able to answer "who, and how many".
  handler: (req, res, _next, options) => {
    const key = (req as Request & { rateLimit?: { key?: string } }).rateLimit?.key
    res.locals.refusalReason = `sign-in throttled (${key ?? 'unknown key'})`
    res.status(options.statusCode).json(options.message)
  },
  message: { success: false, error: 'Too many failed sign-in attempts for this account. Please try again in 15 minutes.' },
})

/**
 * Forget an account's failed attempts.
 *
 * A professor resetting a student's password is the recovery path for exactly the
 * student the throttle has locked out, and until this existed the two fought each
 * other: the password changed, the bucket did not, and the student kept getting 429
 * with the new password their professor had just read out to them. One account in
 * the 140-seat lecture spent thirteen minutes that way.
 *
 * Both keys are cleared because the throttle keys on whatever the student typed, and
 * a student who tried their NetID and then their email has filled two buckets.
 *
 * Not a hole: the caller has already proved they own the class and may set this
 * student's password. Someone who can choose the password gains nothing from also
 * being able to forget the failures.
 */
export async function clearLoginThrottle(...credentials: string[]): Promise<void> {
  await Promise.all(
    credentials
      .filter(Boolean)
      .map((c) => loginRateLimiter.resetKey(`acct:${c.trim().toLowerCase()}`))
  )
}
