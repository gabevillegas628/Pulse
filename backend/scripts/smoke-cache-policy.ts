/**
 * Smoke test for the API cache policy — the 14 Sep sign-in loop.
 *
 * A browser that stored an API response replayed its `X-Pulse-Token` header days later,
 * when the server answered a conditional request 304. This asserts the server can no longer
 * set that up: API responses say no-store, carry no ETag, and a conditional request gets a
 * full 200 whose header is the current one. A control app without the policy shows the 304
 * that made the replay possible, so a pass here means something.
 *
 * It mounts a stand-in route rather than the real app, so it needs no database and no
 * environment beyond the repo.
 *
 * Usage:
 *   npx tsx scripts/smoke-cache-policy.ts
 */
import express from 'express'
import { applyApiCachePolicy } from '../src/middleware/no-store.middleware.js'

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(48)} ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}`)
}

/** A route shaped like /api/addin/live: the same body every time, a renewal header on it. */
function build(withPolicy: boolean) {
  const app = express()
  if (withPolicy) applyApiCachePolicy(app)
  let n = 0
  app.get('/api/live', (_req, res) => {
    res.setHeader('X-Pulse-Token', `token-${++n}`)
    res.json({ data: { session: null } })
  })
  app.get('/health', (_req, res) => { res.json({ status: 'ok' }) })
  return app
}

function listen(app: express.Express): Promise<{ base: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number }
      resolve({ base: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
  })
}

/**
 * Headers for a revalidation the way a browser's cache sends one.
 *
 * Node's fetch appends `Cache-Control: no-cache` to any request carrying If-None-Match unless
 * one is already there, and Express treats no-cache as "never fresh" — so without this the
 * control below can't produce the 304 a real browser gets.
 */
const revalidate = (etag: string) => ({ 'If-None-Match': etag, 'Cache-Control': 'max-age=0' })

// The validator a pre-fix browser holds. The body is identical in both apps, so it is
// exactly what a poisoned cache would send to the fixed server.
let etag: string | null = null

// Control: without the policy, a matching If-None-Match earns a 304.
{
  const { base, close } = await listen(build(false))
  const first = await fetch(`${base}/api/live`)
  etag = first.headers.get('etag')
  check('control: ETag issued without the policy', etag != null, true)
  const again = await fetch(`${base}/api/live`, { headers: revalidate(etag ?? '') })
  check('control: conditional request answered 304', again.status, 304)
  close()
}

{
  const { base, close } = await listen(build(true))
  const first = await fetch(`${base}/api/live`)
  check('API response says no-store', first.headers.get('cache-control'), 'no-store')
  check('API response carries no ETag', first.headers.get('etag'), null)

  // A poisoned cache from before the fix sends the old validator. It must get a full answer.
  const stale = await fetch(`${base}/api/live`, { headers: revalidate(etag ?? '') })
  check('old validator answered 200, not 304', stale.status, 200)
  check('and with the current renewal header', stale.headers.get('x-pulse-token'), 'token-2')

  const health = await fetch(`${base}/health`)
  check('non-API route not marked no-store', health.headers.get('cache-control'), null)
  close()
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
