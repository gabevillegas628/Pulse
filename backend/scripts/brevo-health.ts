/**
 * Whether we can still send, and whether we deserve to.
 *
 * `email-events.ts` answers "what happened to this one message". This answers the
 * question you have before a lecture: is the account in a state where reset mail will
 * actually go out. Two different things decide that, and only one of them is quota.
 *
 * Quota is the easy half — a free plan is a fixed number of sends a day, and the
 * remaining credit says how many are left.
 *
 * Reputation is the half that bites. Providers judge a sender on the share of mail
 * that bounces, and a burst of bad addresses can wreck a spotless record in one
 * afternoon: forty test sends to accounts that did not exist took this one from zero
 * bounces to seventy-five per cent. Nothing announces that. The rate is computed over
 * a rolling window, so it recovers as real delivered mail accumulates — which is why
 * the report below is worth reading over a week, not just today.
 *
 * Brevo exposes no "your account is under review" flag, so this reports the proxies
 * that are visible: credit remaining, whether the relay is enabled, and whether
 * anything has actually been delivered lately. All three healthy is good evidence and
 * not a guarantee; the decisive test is sending one message to an address you own.
 *
 * Usage:
 *   npx tsx scripts/brevo-health.ts
 *   npx tsx scripts/brevo-health.ts 30      # look back 30 days instead of 7
 *
 * Run it directly rather than through `npm run` — PowerShell eats the arguments.
 */

import 'dotenv/config'
import { config } from '../src/config/index.js'

const days = Number(process.argv[2] ?? 7)

/** Above this share of hard bounces, providers start throttling a sender. */
const BOUNCE_RATE_CONCERN = 5

type Report = {
  requests?: number
  delivered?: number
  hardBounces?: number
  softBounces?: number
  blocked?: number
  spamReports?: number
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`https://api.brevo.com/v3${path}`, {
    headers: { 'api-key': config.brevoApiKey, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Brevo returned ${res.status}: ${(await res.text()).slice(0, 300)}`)
  return res.json() as Promise<T>
}

const day = (offset = 0) => new Date(Date.now() - offset * 864e5).toISOString().slice(0, 10)

function line(label: string, r: Report) {
  const sent = r.requests ?? 0
  const bounced = r.hardBounces ?? 0
  const rate = sent ? (100 * bounced) / sent : 0
  console.log(`  ${label}`)
  console.log(
    `    requests ${sent}   delivered ${r.delivered ?? 0}   hardBounces ${bounced}` +
    `   softBounces ${r.softBounces ?? 0}   blocked ${r.blocked ?? 0}   spam ${r.spamReports ?? 0}`
  )
  if (sent) console.log(`    hard-bounce rate ${rate.toFixed(1)}%`)
  return { sent, bounced, rate }
}

async function main() {
  if (!config.brevoApiKey) {
    console.error('  BREVO_API_KEY is not set — nothing to query.')
    process.exit(1)
  }

  const account = await get<{
    plan?: { type?: string; credits?: number; creditsType?: string }[]
    relay?: { enabled?: boolean }
  }>('/account')

  console.log('\n  === Can we send at all? ===')
  let credits: number | null = null
  for (const p of account.plan ?? []) {
    if (p.creditsType === 'sendLimit' && typeof p.credits === 'number') credits = p.credits
    console.log(`    plan ${p.type ?? '?'}   credits ${p.credits ?? 'n/a'} (${p.creditsType ?? 'n/a'})`)
  }
  console.log(`    smtp relay enabled: ${account.relay?.enabled ?? 'unknown'}`)

  console.log('\n  === Sending record ===')
  const today = line(`today (${day()})`, await get<Report>(
    `/smtp/statistics/aggregatedReport?startDate=${day()}&endDate=${day()}`
  ))
  const window = line(`last ${days} days (${day(days - 1)} -> ${day()})`, await get<Report>(
    `/smtp/statistics/aggregatedReport?startDate=${day(days - 1)}&endDate=${day()}`
  ))

  console.log('\n  === Verdict ===')
  if (credits !== null && credits <= 0) {
    console.log('    OUT OF CREDIT. Nothing will send until the daily limit resets.')
  } else if (account.relay?.enabled === false) {
    console.log('    THE RELAY IS DISABLED. Sending is off regardless of credit.')
  } else if (window.rate > BOUNCE_RATE_CONCERN) {
    console.log(`    Sending looks available${credits !== null ? ` (${credits} credits left)` : ''},`)
    console.log(`    but ${window.rate.toFixed(1)}% of the last ${days} days hard-bounced, against a ~${BOUNCE_RATE_CONCERN}% threshold.`)
    console.log('    That is the number that gets an account reviewed. It falls as real')
    console.log('    delivered mail accumulates, so the fix is time and genuine sends,')
    console.log('    not another test run.')
  } else if (!window.sent) {
    console.log('    Nothing sent in the window — no reputation signal either way.')
  } else {
    console.log(`    Healthy${credits !== null ? `: ${credits} credits left` : ''}, bounce rate ${window.rate.toFixed(1)}%.`)
  }

  if (today.bounced > 0) {
    console.log(`\n    ${today.bounced} hard bounce(s) today. If those were test addresses, the`)
    console.log('    reputation hit is real even though the recipients were not.')
  }
  console.log('\n  Brevo publishes no "under review" flag. The decisive check is sending one')
  console.log('  message to an address you own and confirming it lands.\n')
}

main().catch((err) => {
  console.error('\nFATAL:', err instanceof Error ? err.message : err)
  process.exit(1)
})
