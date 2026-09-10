/**
 * Password hashing, behind one seam.
 *
 * The 9 Sep lecture put roughly a hundred and fifteen students through /login inside forty
 * seconds, and every unrelated request slowed with them — a 304 with an empty body took
 * 3.2s, a favicon took 2.4s. Neither has a bandwidth explanation. The cause is that
 * `bcryptjs` is pure JavaScript: its async API is not backed by a threadpool, it chunks
 * work with setImmediate and runs on the main thread, so each verification is a few
 * hundred milliseconds the event loop cannot spend on anything else. A measured ladder
 * against Pulse-Dev put login p50 at 17.5s and a *static file* at 21.5s under 150 logins.
 *
 * `@node-rs/bcrypt` is a Rust addon whose async calls run on their own threadpool, so the
 * same work leaves the event loop free. It ships prebuilt binaries for linux-x64 (Railway)
 * and win32-x64 (dev), so there is no node-gyp step in the deploy.
 *
 * The two are wire-compatible in both directions — verified before this was written:
 * node-rs verifies the `$2a$` hashes bcryptjs produced, and bcryptjs verifies the `$2b$`
 * hashes node-rs produces. No stored hash has to change and no student resets a password,
 * which is also what makes rolling back safe.
 *
 * PASSWORD_BACKEND exists so the A/B could be one deploy and two restarts rather than two
 * builds, keeping the container, the database and the network identical across the
 * comparison. Once the result is acted on, this collapses to node-rs alone.
 */

import bcryptjs from 'bcryptjs'
import * as nodeRs from '@node-rs/bcrypt'

/** Matches every hash already in the database. Not a knob to turn casually: lowering it
 *  silently weakens every password hashed afterwards, while leaving old ones untouched. */
export const COST = 12

export type PasswordBackend = 'bcryptjs' | 'node-rs'

/** Defaults to the fast one. The slow one stays reachable only to reproduce the fault. */
export const backend: PasswordBackend =
  process.env.PASSWORD_BACKEND === 'bcryptjs' ? 'bcryptjs' : 'node-rs'

export async function hash(plain: string): Promise<string> {
  return backend === 'bcryptjs' ? bcryptjs.hash(plain, COST) : nodeRs.hash(plain, COST)
}

export async function verify(plain: string, stored: string): Promise<boolean> {
  return backend === 'bcryptjs' ? bcryptjs.compare(plain, stored) : nodeRs.verify(plain, stored)
}
