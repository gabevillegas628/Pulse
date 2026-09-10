/**
 * Password hashing.
 *
 * This used `bcryptjs`, which is pure JavaScript: its async API is not backed by a
 * threadpool, it chunks work with setImmediate and runs on the main thread. Each
 * verification is therefore a few hundred milliseconds the event loop cannot spend on
 * anything else, and a lecture that signs in at once slows *everything* at once. The
 * 9 Sep logs show it plainly — a 304 with an empty body took 3.2s, a favicon took 2.4s,
 * neither of which has a bandwidth explanation.
 *
 * Measured against Pulse-Dev, 150 logins spread over 15s, same container and database,
 * the library swapped underneath:
 *
 *                  bcryptjs     @node-rs/bcrypt
 *   login p50       17472ms              534ms
 *   login p99       27368ms              933ms
 *   favicon p99     21501ms             1110ms
 *   /health p99     21114ms              523ms
 *
 * favicon.svg touches neither Postgres nor bcrypt, so its 21.5s under the old library —
 * against a 52ms quiet baseline — left the event loop as the only resource it could have
 * been sharing with /login. A control run held the refactor constant and reselected
 * bcryptjs, reproducing 17526ms: the seam was inert and the whole delta is the library.
 *
 * Do not reach for `bcryptjs` again. It is still in package.json because ten dev scripts
 * and the Prisma seed use it, none of which run while a room is waiting.
 *
 * The two are wire-compatible in both directions — node-rs verifies the `$2a$` hashes
 * bcryptjs wrote, and bcryptjs verifies node-rs's `$2b$` — so nothing stored had to
 * change, no student reset a password, and reverting this file is safe.
 */

import { hash as nodeRsHash, verify as nodeRsVerify } from '@node-rs/bcrypt'

/**
 * Matches every hash already in the database. Not a knob to turn casually: lowering it
 * silently weakens every password hashed afterwards while leaving old ones untouched.
 */
export const COST = 12

export async function hash(plain: string): Promise<string> {
  return nodeRsHash(plain, COST)
}

export async function verify(plain: string, stored: string): Promise<boolean> {
  return nodeRsVerify(plain, stored)
}
