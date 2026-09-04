import { config } from '../config/index.js'
import { logger } from '../utils/logger.js'
import { captureException } from '../utils/reporting.js'

/**
 * Transactional email, over Brevo's HTTP API.
 *
 * The API rather than SMTP, and `fetch` rather than a client library: one POST with
 * an `api-key` header is the whole protocol, and Node has had fetch built in since
 * 18. Adding nodemailer plus an SDK to send one kind of message would be more
 * dependency than feature.
 *
 * Nothing here throws at the caller. Every caller so far is a route that must answer
 * the same way whether or not the mail went out — see the forgot-password route —
 * so a failure is reported through captureException and swallowed. `sendEmail`
 * returns whether it sent, for callers that want to log it; none may branch on it in
 * a way a stranger can observe.
 */

const BREVO_ENDPOINT = 'https://api.brevo.com/v3/smtp/email'

/** Brevo occasionally hangs rather than refusing. A request path must not hang with it. */
const SEND_TIMEOUT_MS = 10_000

export interface OutboundEmail {
  to: string
  subject: string
  html: string
  /** Always sent alongside the HTML: some university clients render nothing else. */
  text: string
}

/** Whether both halves of the sender identity are present. */
export function emailConfigured(): boolean {
  return Boolean(config.brevoApiKey && config.emailUser)
}

/**
 * In development the link is the thing you actually want, and wiring a real sender
 * to read it is friction. Unconfigured plus dev prints the message and reports it as
 * sent, so the reset flow is testable with no API key at all.
 *
 * Unconfigured in production is a different thing entirely — students are asking for
 * mail that will never arrive — so it is logged at error and reported.
 */
function handleUnconfigured(email: OutboundEmail): boolean {
  if (config.isDev) {
    logger.info(
      `[email] not configured — would have sent to ${email.to}\n` +
      `  subject: ${email.subject}\n` +
      email.text.split('\n').map((l) => `  ${l}`).join('\n')
    )
    return true
  }
  captureException(
    new Error('email is not configured — BREVO_API_KEY and EMAIL_USER must both be set'),
    { source: 'email.service' }
  )
  return false
}

export async function sendEmail(email: OutboundEmail): Promise<boolean> {
  if (!emailConfigured()) return handleUnconfigured(email)

  try {
    const res = await fetch(BREVO_ENDPOINT, {
      method: 'POST',
      headers: {
        'api-key': config.brevoApiKey,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({
        sender: { email: config.emailUser, name: config.emailFromName },
        to: [{ email: email.to }],
        subject: email.subject,
        htmlContent: email.html,
        textContent: email.text,
      }),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })

    if (!res.ok) {
      // Brevo's refusals are the actionable ones — an unverified sender, a spent
      // quota, a revoked key — and they are indistinguishable from a working setup
      // without the body, so it is read before being thrown away. Truncated because
      // an HTML error page from a proxy would otherwise land whole in the log.
      const detail = await res.text().catch(() => '')
      captureException(
        new Error(`Brevo refused the send: ${res.status} ${detail.slice(0, 500)}`),
        { source: 'email.service' }
      )
      return false
    }

    return true
  } catch (err) {
    captureException(err, { source: 'email.service' })
    return false
  }
}
