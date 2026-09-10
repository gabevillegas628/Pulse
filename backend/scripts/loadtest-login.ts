/**
 * Login load driver — reproduces the QR-code stampede against a real deployment.
 *
 * The question this exists to answer: when a lecture hall opens a question and the whole
 * roster signs in inside twenty seconds, what is the thing that gets slow? The 9 Sep logs
 * showed every path slow at once, including a 304 with an empty body that took 3.2s and a
 * favicon that took 2.4s. Neither has a bandwidth explanation, which points at the server
 * rather than the room's wifi — but "points at" is not "proves", and the two candidates
 * (the event loop, blocked by pure-JS bcrypt; or the Prisma pool, exhausted by the lookup
 * each login does first) produce nearly identical login latency.
 *
 * They do not produce identical *bystander* latency, which is what this measures.
 *
 *   /favicon.svg   static file. No database, no bcrypt. Slow only if the event loop is.
 *   /health        SELECT 1. Needs the event loop *and* a pool connection.
 *
 * Both slow says event loop. Only /health slow says pool. That distinction is the entire
 * point of the run; a driver that recorded login latency alone would produce a confident
 * number that cannot tell the two apart.
 *
 * Two things are measured about the driver itself, because a load test that quietly failed
 * to generate load looks exactly like a system that handled it. `maxInFlight` well under
 * the target, or driver lag in the same range as the server's, invalidates the run.
 *
 * Usage:
 *   railway run --service Pulse-Dev npx tsx scripts/loadtest-login.ts --seed
 *   railway run --service Pulse-Dev npx tsx scripts/loadtest-login.ts --ladder
 *   railway run --service Pulse-Dev npx tsx scripts/loadtest-login.ts --run --n 150
 *   railway run --service Pulse-Dev npx tsx scripts/loadtest-login.ts --cleanup
 *
 * `railway run` executes this locally with Pulse-Dev's environment injected. That is the
 * arrangement we want — the driver on a laptop, the server on Railway hardware — and it
 * also means the database is chosen by service name rather than by trusting a local file.
 *
 * Seeding writes to whatever DATABASE_URL resolves to. Every account carries the prefix
 * below and --cleanup keys off it, so a run leaves nothing behind.
 */

import 'dotenv/config'
import { writeFileSync, mkdirSync } from 'node:fs'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import bcrypt from 'bcryptjs'
import { PrismaClient } from '@prisma/client'

/**
 * The only host this will talk to.
 *
 * `Pulse main` and `Pulse-Dev` are services inside the same Railway environment, so
 * nothing about the CLI's linkage keeps a stray flag off production. The safety boundary
 * is this string, and the failure mode for getting it wrong is a refusal to start rather
 * than a hundred and fifty logins against a live class.
 */
const ALLOWED_HOST = 'pulse-dev-production-7bcb.up.railway.app'

const PREFIX = 'loadtest-'
/**
 * Cost 12, matching production. rehearse.ts seeds at cost 4, which is roughly 250x cheaper
 * to verify and would measure nothing about the path under test.
 */
const COST = 12
const PASSWORD = 'loadtest-password'

const argv = process.argv.slice(2)
const flag = (name: string) => argv.includes(`--${name}`)
const opt = (name: string, fallback: string) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const BASE = process.env.LOADTEST_BASE ?? `https://${ALLOWED_HOST}`

/**
 * The only database service this will write to.
 *
 * Pulse-Dev's own DATABASE_URL is a `.railway.internal` address, which resolves only from
 * inside Railway's network — so a driver running on a laptop cannot use it, and reaching
 * for a public URL instead means the internal-hostname safety-by-accident is gone. This
 * takes its place: `railway run --service <name>` injects RAILWAY_SERVICE_NAME, so the
 * clone can be named and anything else refused.
 */
const ALLOWED_DB_SERVICE = 'Postgres-bpMI Copy'

/**
 * Public proxy first. Running under the Postgres service gives both, and only the public
 * one is reachable from here.
 */
function resolveDatabaseUrl(): string {
  const svc = process.env.RAILWAY_SERVICE_NAME
  if (svc !== ALLOWED_DB_SERVICE) {
    console.error(`refusing to touch a database as service "${svc ?? '(none)'}"`)
    console.error(`this driver only writes to "${ALLOWED_DB_SERVICE}"; run it as:`)
    console.error(`  railway run --service "${ALLOWED_DB_SERVICE}" npx tsx scripts/loadtest-login.ts ...`)
    process.exit(1)
  }
  const url = process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL
  if (!url) {
    console.error('no DATABASE_PUBLIC_URL or DATABASE_URL in the environment')
    process.exit(1)
  }
  if (url.includes('.railway.internal')) {
    console.error('resolved an internal Railway hostname, which does not resolve off-platform')
    console.error('DATABASE_PUBLIC_URL is the one that works from a laptop')
    process.exit(1)
  }
  return url
}

const prisma = new PrismaClient({
  datasources: { db: { url: resolveDatabaseUrl() } },
})

function assertSafeTarget(): void {
  let host: string
  try {
    host = new URL(BASE).host
  } catch {
    console.error(`refusing to run: LOADTEST_BASE is not a URL (${BASE})`)
    process.exit(1)
  }
  if (host !== ALLOWED_HOST) {
    console.error(`refusing to run against ${host}`)
    console.error(`this driver only targets ${ALLOWED_HOST}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------- measurement

interface Sample {
  t: number
  ms: number
  status: number
  note?: string
}

function pct(xs: number[], p: number): number {
  if (xs.length === 0) return NaN
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

const fmt = (n: number) => (Number.isNaN(n) ? '—' : `${Math.round(n)}ms`)

function summarise(label: string, xs: number[]): string {
  if (xs.length === 0) return `${label.padEnd(16)} (no samples)`
  return [
    label.padEnd(16),
    `n=${String(xs.length).padStart(4)}`,
    `p50=${fmt(pct(xs, 50)).padStart(8)}`,
    `p95=${fmt(pct(xs, 95)).padStart(8)}`,
    `p99=${fmt(pct(xs, 99)).padStart(8)}`,
    `max=${fmt(Math.max(...xs)).padStart(8)}`,
  ].join('  ')
}

// ---------------------------------------------------------------- seed / clean

async function seed(n: number): Promise<void> {
  console.log(`seeding ${n} accounts at bcrypt cost ${COST}...`)
  // Hashed once and shared. The run measures verification, not hashing, and hashing 150
  // times at cost 12 would add half a minute to setup for no signal.
  const passwordHash = await bcrypt.hash(PASSWORD, COST)
  const rows = Array.from({ length: n }, (_, i) => ({
    netId: `${PREFIX}${i}`,
    email: `${PREFIX}${i}@example.invalid`,
    passwordHash,
  }))
  await prisma.student.createMany({ data: rows, skipDuplicates: true })
  const have = await prisma.student.count({ where: { netId: { startsWith: PREFIX } } })
  console.log(`done — ${have} accounts carry the ${PREFIX} prefix`)
}

async function cleanup(): Promise<void> {
  const where = { student: { netId: { startsWith: PREFIX } } }
  // Defensive: these accounts should only ever have a Student row, but a half-finished
  // experiment is exactly when that stops being true.
  await prisma.response.deleteMany({ where })
  await prisma.enrollment.deleteMany({ where })
  await prisma.deadlineExtension.deleteMany({ where })
  await prisma.passwordResetToken.deleteMany({ where })
  const { count } = await prisma.student.deleteMany({
    where: { netId: { startsWith: PREFIX } },
  })
  console.log(`removed ${count} accounts`)
}

// ---------------------------------------------------------------- the run

async function login(i: number): Promise<Sample> {
  const t0 = performance.now()
  const wall = Date.now()
  try {
    const res = await fetch(`${BASE}/api/auth/student/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credential: `${PREFIX}${i}`, password: PASSWORD }),
    })
    // Drained so the timing covers the whole response, not just its headers.
    const body = await res.text().catch(() => '')
    const note = res.ok ? undefined : body.slice(0, 120)
    return { t: wall, ms: performance.now() - t0, status: res.status, note }
  } catch (err) {
    return { t: wall, ms: performance.now() - t0, status: 0, note: String(err).slice(0, 120) }
  }
}

async function probe(path: string): Promise<Sample> {
  const t0 = performance.now()
  const wall = Date.now()
  try {
    const res = await fetch(`${BASE}${path}`, { cache: 'no-store' })
    await res.arrayBuffer().catch(() => undefined)
    return { t: wall, ms: performance.now() - t0, status: res.status }
  } catch (err) {
    return { t: wall, ms: performance.now() - t0, status: 0, note: String(err).slice(0, 80) }
  }
}

interface RunResult {
  n: number
  spreadSec: number
  startedAt: string
  logins: Sample[]
  favicon: Sample[]
  health: Sample[]
  maxInFlight: number
  driverLagMaxMs: number
  quiet: { favicon: number; health: number }
}

/**
 * One rung. Probes run before, during and after so the storm is compared against the same
 * endpoint's own quiet baseline rather than against an assumption about what "fast" means.
 */
async function runOnce(n: number, spreadSec: number): Promise<RunResult> {
  // A wrong password would cost each account one of its ten attempts, and the throttle's
  // window is fifteen minutes — long enough to poison every later rung. One real login
  // first is cheap insurance.
  const check = await login(0)
  if (check.status !== 200) {
    throw new Error(`smoke login failed (${check.status}) — refusing to storm: ${check.note ?? ''}`)
  }

  const favicon: Sample[] = []
  const health: Sample[] = []
  let stopProbes = false
  const probeLoop = async (path: string, into: Sample[]) => {
    while (!stopProbes) {
      into.push(await probe(path))
      await new Promise((r) => setTimeout(r, 250))
    }
  }
  const probesDone = Promise.all([
    probeLoop('/favicon.svg', favicon),
    probeLoop('/health', health),
  ])

  // Five seconds of quiet, so each rung carries its own control.
  await new Promise((r) => setTimeout(r, 5000))
  const quietMark = Date.now()
  const quiet = {
    favicon: pct(favicon.map((s) => s.ms), 95),
    health: pct(health.map((s) => s.ms), 95),
  }

  const lag = monitorEventLoopDelay({ resolution: 10 })
  lag.enable()

  let inFlight = 0
  let maxInFlight = 0
  const startedAt = new Date().toISOString()

  // Offsets are uniform-random across the window rather than evenly spaced: a room scans a
  // projected QR code at whatever moment each person looks up, and evenly spaced arrivals
  // would understate the clustering that actually happens.
  const logins = await Promise.all(
    Array.from({ length: n }, (_, i) => {
      const delay = spreadSec === 0 ? 0 : Math.random() * spreadSec * 1000
      return new Promise<Sample>((resolve) => {
        setTimeout(async () => {
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          const s = await login(i)
          inFlight -= 1
          resolve(s)
        }, delay)
      })
    })
  )

  lag.disable()
  // Ten seconds of tail, to see whether the queue drains or keeps growing.
  await new Promise((r) => setTimeout(r, 10_000))
  stopProbes = true
  await probesDone

  return {
    n,
    spreadSec,
    startedAt,
    logins,
    favicon: favicon.filter((s) => s.t >= quietMark),
    health: health.filter((s) => s.t >= quietMark),
    maxInFlight,
    driverLagMaxMs: lag.max / 1e6,
    quiet,
  }
}

function report(r: RunResult): void {
  const ok = r.logins.filter((s) => s.status === 200)
  const bad = r.logins.filter((s) => s.status !== 200)
  console.log(`\n--- ${r.n} logins over ${r.spreadSec}s ${'-'.repeat(32)}`)
  console.log(summarise('login', ok.map((s) => s.ms)))
  console.log(
    summarise('favicon.svg', r.favicon.map((s) => s.ms)) + `   quiet p95 ${fmt(r.quiet.favicon)}`
  )
  console.log(
    summarise('/health', r.health.map((s) => s.ms)) + `   quiet p95 ${fmt(r.quiet.health)}`
  )
  console.log(
    `driver           maxInFlight=${r.maxInFlight}/${r.n}   driverLagMax=${fmt(r.driverLagMaxMs)}`
  )
  if (bad.length) {
    const by = new Map<number, number>()
    bad.forEach((s) => by.set(s.status, (by.get(s.status) ?? 0) + 1))
    console.log(`failures         ${[...by].map(([s, c]) => `${s}x${c}`).join('  ')}`)
    console.log(`  first: ${bad[0].note ?? ''}`)
  }

  // The whole reason for two probes. Stated rather than left to the reader, because the
  // wrong reading here sends the fix to the wrong subsystem.
  const fSlow = pct(r.favicon.map((s) => s.ms), 99) > Math.max(300, r.quiet.favicon * 5)
  const hSlow = pct(r.health.map((s) => s.ms), 99) > Math.max(300, r.quiet.health * 5)
  const verdict =
    fSlow && hSlow
      ? 'EVENT LOOP — both bystanders stalled'
      : !fSlow && hSlow
        ? 'DB POOL — only the query path stalled'
        : fSlow && !hSlow
          ? 'threadpool/fs — static slow, query fine (neither hypothesis)'
          : 'no bystander impact at this rung'
  console.log(`verdict          ${verdict}`)

  if (r.spreadSec === 0 && r.maxInFlight < r.n * 0.5) {
    console.log('WARNING          driver never reached half the target concurrency')
  }
}

// ---------------------------------------------------------------- entry

async function main(): Promise<void> {
  assertSafeTarget()
  console.log(`target ${BASE}`)

  if (flag('cleanup')) return cleanup()
  if (flag('seed')) return seed(Number(opt('students', '150')))

  const spread = Number(opt('spread', '15'))
  const rungs = flag('ladder')
    ? opt('rungs', '25,50,100,150').split(',').map(Number)
    : [Number(opt('n', '150'))]

  const have = await prisma.student.count({ where: { netId: { startsWith: PREFIX } } })
  const need = Math.max(...rungs)
  if (have < need) {
    throw new Error(`only ${have} seeded accounts, need ${need} — run --seed first`)
  }

  const results: RunResult[] = []
  for (const [idx, n] of rungs.entries()) {
    const r = await runOnce(n, spread)
    report(r)
    results.push(r)
    if (idx < rungs.length - 1) {
      console.log('\n... 60s recovery before the next rung')
      await new Promise((res) => setTimeout(res, 60_000))
    }
  }

  mkdirSync('loadtest-results', { recursive: true })
  const backend = process.env.PASSWORD_BACKEND ?? 'bcryptjs'
  const file = `loadtest-results/${backend}-${Date.now()}.json`
  writeFileSync(file, JSON.stringify({ backend, base: BASE, results }, null, 2))
  console.log(`\nwrote ${file}`)
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
