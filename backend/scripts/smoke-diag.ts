/**
 * Smoke test for the client diagnostic beacon.
 *
 * `POST /api/client-diag` is unauthenticated by necessity — the event it exists to report
 * is "the professor token is gone", and requiring a token would make it silent in exactly
 * the case it was built for. That makes it the one open write path into the server log, so
 * what is asserted here is mostly what it *refuses*: malformed bodies, unknown keys, junk
 * event names, unbounded strings, and more than 30 reports a minute.
 *
 * It mounts the router directly rather than talking to a running server, so it needs no
 * database and no environment beyond the repo.
 *
 * Usage:
 *   npx tsx scripts/smoke-diag.ts
 */
import express from 'express'
import diagRoutes from '../src/routes/diag.routes.js'
import { errorMiddleware } from '../src/middleware/error.middleware.js'

const app = express()
app.use(express.json())
app.use('/api', diagRoutes)
app.use(errorMiddleware)

const valid = {
  event: 'token-vanished',
  at: new Date().toISOString(),
  path: '/professor/sessions/abc',
  key: 'professor_token',
  byApp: false,
  appStack: null,
  byOtherTab: null,
  canaryLocal: true,
  canaryIdb: true,
  keyCount: 4,
  tokenTail: 'OOacM',
  tokenIat: 1757000000,
  tokenExp: 1757086400,
  ageSec: 3600,
  visibility: 'visible',
}

let failures = 0

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = actual === expected
  if (!ok) failures++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label.padEnd(42)} ${String(actual)}${ok ? '' : ` (expected ${String(expected)})`}`)
}

const server = app.listen(0, async () => {
  const { port } = server.address() as { port: number }
  const url = `http://127.0.0.1:${port}/api/client-diag`

  const post = async (body: unknown): Promise<number> => {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return r.status
  }

  // A well-formed report is accepted, and answered 204 — sendBeacon cannot read a body.
  check('valid report accepted', await post(valid), 204)

  // Every refusal is also 204. A beacon has no caller to show a 400 to, and answering
  // anything else would only teach a prober what the schema is.
  check('missing fields refused', await post({ event: 'boot' }), 204)
  check('unknown event name refused', await post({ ...valid, event: 'nonsense' }), 204)
  check('overlong stack refused', await post({ ...valid, appStack: 'x'.repeat(5000) }), 204)
  check('keyCount out of range refused', await post({ ...valid, keyCount: 99999 }), 204)
  // Body-parser refusals never reach the route, so they keep their own honest status —
  // 400, not the 500 the error middleware's catch-all used to hand them.
  check('malformed body answered 400, not 500', await post('just a string'), 400)

  // Unknown keys are stripped rather than rejected, so a newer client reporting a field
  // this server does not know about still gets its report logged.
  check('unknown keys stripped, not refused', await post({ ...valid, evil: 'DROP TABLE', token: 'a.b.c' }), 204)

  // 30 a minute. The seven above already count against the window.
  let limited = 0
  for (let i = 0; i < 40; i++) if (await post(valid) === 429) limited++
  check('rate limiter refuses the excess', limited > 0, true)

  server.close()
  console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
  process.exit(failures === 0 ? 0 : 1)
})
