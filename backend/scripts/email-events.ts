/**
 * Ask the provider what actually happened to mail we sent to an address.
 *
 * `sendEmail` can only report that Brevo accepted a message. Acceptance is not
 * delivery: a hard bounce, a block by the receiving gateway, or a spam placement all
 * happen afterwards and are invisible to the app. That gap is exactly what makes
 * "students say they never got it" hard to diagnose, so this reads it back.
 *
 * Usage:
 *   npx tsx scripts/email-events.ts someone@example.edu
 *   npx tsx scripts/email-events.ts someone@example.edu 7    # look back 7 days
 *
 * Run it directly rather than through `npm run` — PowerShell eats the arguments.
 */

import 'dotenv/config'
import { config } from '../src/config/index.js'

const email = process.argv[2]
const days = Number(process.argv[3] ?? 1)

if (!email) {
  console.error('Usage: npx tsx scripts/email-events.ts <recipient@example.com> [days]')
  process.exit(1)
}

/** What each event means for someone staring at "they never got it". */
const MEANING: Record<string, string> = {
  requests: 'we handed it to Brevo',
  delivered: 'the receiving server accepted it — if it is not in the inbox, it is in spam',
  hardBounces: 'the address does not exist, or the server refused permanently',
  softBounces: 'temporary failure — mailbox full, greylisting, server busy',
  blocked: 'Brevo refused to send it (suppression list, or a prior bounce/complaint)',
  spam: 'the recipient marked it as spam',
  invalid: 'the address is malformed or known-bad',
  deferred: 'the receiving server asked Brevo to try again later',
  opened: 'someone opened it',
  clicks: 'someone clicked a link in it',
  unsubscribed: 'the recipient unsubscribed',
  error: 'Brevo recorded an error for this message',
}

async function main() {
  if (!config.brevoApiKey) {
    console.error('  BREVO_API_KEY is not set — nothing to query.')
    process.exit(1)
  }

  const url = new URL('https://api.brevo.com/v3/smtp/statistics/events')
  url.searchParams.set('email', email)
  url.searchParams.set('days', String(days))
  url.searchParams.set('limit', '100')

  const res = await fetch(url, {
    headers: { 'api-key': config.brevoApiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    console.error(`\n  Brevo returned ${res.status}: ${(await res.text()).slice(0, 500)}\n`)
    process.exit(1)
  }

  const body = (await res.json()) as {
    events?: { email: string; date: string; event: string; reason?: string; subject?: string }[]
  }
  const events = body.events ?? []

  console.log(`\n  ${email} — last ${days} day(s): ${events.length} event(s)\n`)

  if (!events.length) {
    console.log('  No events. Either nothing was sent to this address in the window,')
    console.log('  or the send never reached Brevo at all.\n')
    return
  }

  // Oldest first reads as a story: requested, then delivered or not.
  for (const e of [...events].reverse()) {
    const when = new Date(e.date).toISOString().replace('T', ' ').slice(0, 19)
    console.log(`  ${when}  ${e.event.padEnd(12)} ${MEANING[e.event] ?? ''}`)
    if (e.reason) console.log(`  ${' '.repeat(19)}  reason: ${e.reason}`)
  }

  const kinds = new Set(events.map((e) => e.event))
  console.log('')
  if (kinds.has('hardBounces') || kinds.has('invalid')) {
    console.log('  VERDICT: the address is bad or permanently refusing. Not a spam-folder problem.')
  } else if (kinds.has('blocked')) {
    console.log('  VERDICT: Brevo itself refused to send. Check the suppression list in the Brevo dashboard.')
  } else if (kinds.has('softBounces') || kinds.has('deferred')) {
    console.log('  VERDICT: the receiving server is deferring or temporarily failing. Retry and watch.')
  } else if (kinds.has('delivered')) {
    console.log('  VERDICT: the receiving server accepted it. If nobody sees it, it is filed as spam')
    console.log('  on the recipient side — a placement problem, not a sending problem.')
  } else if (kinds.has('requests')) {
    console.log('  VERDICT: handed to Brevo but no delivery event yet. Wait a minute and re-run.')
  }
  console.log('')
}

main().catch((err) => {
  console.error('\nFATAL:', err)
  process.exit(1)
})
