/**
 * Send one real email through the configured provider, to prove the setup works.
 *
 * This is the half of the reset flow the smoke test deliberately cannot reach: whether
 * the key is valid, whether the sender is authenticated, and whether the message
 * actually lands rather than being filed as spam. Worth running after wiring up a new
 * key, after rotating one, and once against production before a term starts.
 *
 * It sends a plainly-labelled test message, not a real reset link, so a stray click
 * cannot change anyone's password.
 *
 * Usage:
 *   npx tsx scripts/send-test-email.ts you@example.com
 *
 * Run it directly rather than through `npm run` — PowerShell eats the argument.
 */

import 'dotenv/config'
import { config } from '../src/config/index.js'
import { sendEmail, emailConfigured } from '../src/services/email.service.js'

const to = process.argv[2]

if (!to) {
  console.error('Usage: npx tsx scripts/send-test-email.ts <recipient@example.com>')
  process.exit(1)
}

async function main() {
  console.log(`\n  provider configured : ${emailConfigured() ? 'yes' : 'NO'}`)
  // The From address is public — it is printed on every message this app sends.
  // The API key is deliberately never shown, only whether one is present.
  console.log(`  from                : ${config.emailFromName} <${config.emailUser || '(unset)'}>`)
  console.log(`  api key             : ${config.brevoApiKey ? 'present' : 'MISSING'}`)
  console.log(`  to                  : ${to}\n`)

  if (!emailConfigured()) {
    console.error('  BREVO_API_KEY and EMAIL_USER must both be set. Nothing was sent.')
    process.exit(1)
  }

  const stamp = new Date().toISOString()

  const sent = await sendEmail({
    to,
    subject: `Pulse email test — ${stamp}`,
    text: [
      'This is a test message from Pulse.',
      '',
      'If it reached you, the sending domain is authenticated and password reset',
      'emails will go out. There is no link to click and nothing to do.',
      '',
      `Sent ${stamp}`,
    ].join('\n'),
    html: `
      <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:480px">
        <p>This is a test message from Pulse.</p>
        <p>If it reached you, the sending domain is authenticated and password reset emails
        will go out. There is no link to click and nothing to do.</p>
        <p style="color:#9b9b9b;font-size:12px;margin-top:24px">Sent ${stamp}</p>
      </div>
    `.trim(),
  })

  if (sent) {
    console.log('  RESULT: accepted by the provider.\n')
    console.log('  Delivery is a separate question from acceptance — check the inbox,')
    console.log('  and the spam folder if it is not there within a minute or two.\n')
  } else {
    console.log('\n  RESULT: NOT sent. The reason is in the captured exception above.\n')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
