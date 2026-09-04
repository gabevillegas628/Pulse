import crypto from 'crypto'
import bcrypt from 'bcryptjs'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'
import { AppError } from '../middleware/error.middleware.js'
import { clearLoginThrottle } from '../middleware/login-throttle.js'
import { sendEmail } from './email.service.js'

/**
 * Emailed password reset for students.
 *
 * The shape is the standard one, and the standard one is standard for reasons worth
 * writing down:
 *
 *   - The token is 32 bytes from the CSPRNG, and only its SHA-256 reaches the
 *     database. Whoever holds the raw token can set the password, so it exists in
 *     exactly two places: one email, and one URL bar.
 *   - Requesting a reset never reveals whether an account exists. The route answers
 *     identically either way, which is why nothing in here throws on an unknown
 *     student — it simply has no student to mail.
 *   - The mail always goes to the address on the row, never to an address the
 *     requester typed. Typing someone's NetID sends mail to *them*, which is the
 *     whole security property.
 *
 * What this inherits and does not fix: a student's email address is never verified at
 * registration. A reset link is therefore only as good as the address that account
 * was created with, and a student who typo'd theirs still has no way back in on their
 * own. That is the same hole as before this feature — the professor-side reset in
 * classes.routes.ts is still the answer for it — but adding email is the moment it
 * starts to matter, so it is written down rather than assumed closed.
 */

const TOKEN_BYTES = 32

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export function resetLinkFor(token: string): string {
  // baseUrl, matching the QR helper: this is a link a student opens on their phone,
  // not the dev server's CORS origin.
  return `${config.baseUrl.replace(/\/$/, '')}/reset-password?token=${encodeURIComponent(token)}`
}

/**
 * Mint a link for a student and mail it.
 *
 * Outstanding links are not revoked here. A student who taps the button twice
 * because the first mail was slow would otherwise be holding a dead link by the time
 * it arrives — the most common way this flow fails people. Both work; redeeming
 * either retires the rest.
 */
export async function sendPasswordResetEmail(student: {
  id: string
  netId: string
  email: string
}): Promise<void> {
  // Cheap and bounded: an indexed delete, run only when someone actually asks for a
  // reset, which keeps the table from accumulating dead rows without a timer.
  await prisma.passwordResetToken.deleteMany({ where: { expiresAt: { lt: new Date() } } })

  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url')
  const expiresAt = new Date(Date.now() + config.passwordResetTtlMinutes * 60 * 1000)

  await prisma.passwordResetToken.create({
    data: { studentId: student.id, tokenHash: hashToken(token), expiresAt },
  })

  const link = resetLinkFor(token)
  const minutes = config.passwordResetTtlMinutes

  const sent = await sendEmail({
    to: student.email,
    subject: 'Reset your Pulse password',
    text: [
      `Someone asked to reset the Pulse password for ${student.netId}.`,
      '',
      `Open this link to choose a new one — it works once, and expires in ${minutes} minutes:`,
      link,
      '',
      'If this was not you, you can ignore this email. Your password has not changed.',
    ].join('\n'),
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:480px">
        <p>Someone asked to reset the Pulse password for <strong>${student.netId}</strong>.</p>
        <p style="margin:24px 0">
          <a href="${link}" style="background:#e5484d;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-weight:600;display:inline-block">Choose a new password</a>
        </p>
        <p style="color:#6b6b6b;font-size:13px">This link works once and expires in ${minutes} minutes.</p>
        <p style="color:#6b6b6b;font-size:13px">If this was not you, you can ignore this email — your password has not changed.</p>
        <p style="color:#9b9b9b;font-size:12px;word-break:break-all;margin-top:24px">${link}</p>
      </div>
    `.trim(),
  })

  // The student is never told, so the log is the only place this is visible.
  if (!sent) logger.warn(`password reset email failed to send for ${student.netId}`)
}

/** A token row that is still good, with the student attached. */
async function findLiveToken(token: string) {
  const row = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { student: { select: { id: true, netId: true, email: true } } },
  })
  if (!row) throw new AppError('This reset link is not valid. Request a new one.', 400)
  if (row.usedAt) throw new AppError('This reset link has already been used. Request a new one.', 400)
  if (row.expiresAt <= new Date()) throw new AppError('This reset link has expired. Request a new one.', 400)
  return row
}

/**
 * Check a link without spending it, so the page can say "expired" before a student
 * types a password rather than after.
 *
 * Returns the NetID on purpose: whoever holds the token can already set that
 * account's password, so naming it leaks nothing, and it is the only thing that
 * tells a student on a shared machine that they are about to reset the right account.
 */
export async function verifyResetToken(token: string): Promise<{ netId: string }> {
  const row = await findLiveToken(token)
  return { netId: row.student.netId }
}

/** Spend a link: set the new password, retire every other link for that student. */
export async function redeemResetToken(token: string, newPassword: string): Promise<void> {
  const row = await findLiveToken(token)
  const passwordHash = await bcrypt.hash(newPassword, 12)
  const now = new Date()

  // One transaction, so a password can never change without its link being spent.
  await prisma.$transaction([
    prisma.student.update({ where: { id: row.studentId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({ where: { id: row.id }, data: { usedAt: now } }),
    // Every other outstanding link for this student dies with it — including the
    // one an attacker may have caused to be issued.
    prisma.passwordResetToken.deleteMany({
      where: { studentId: row.studentId, id: { not: row.id }, usedAt: null },
    }),
  ])

  // The same trap the professor-side reset hit: a student who is resetting is usually
  // a student the sign-in throttle has locked out, and leaving the bucket behind
  // means the new password earns a 429 for the next quarter of an hour. See
  // clearLoginThrottle's own note.
  await clearLoginThrottle(row.student.netId, row.student.email)

  logger.info(`password reset completed for ${row.student.netId}`)
}
