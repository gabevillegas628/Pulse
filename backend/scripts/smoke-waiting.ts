/**
 * Smoke test for the "students are waiting" list behind the slide's Start button.
 *
 * Drives waiting.service.ts directly with injected timestamps. Needs nothing running.
 *
 * Usage:
 *   npx tsx scripts/smoke-waiting.ts
 */

import {
  noteWaiting, noteAdmitted, noteOpened, waitingSnapshot, resetWaiting, WAITING_TTL_MS,
} from '../src/services/waiting.service.js'

let passed = 0
let failed = 0

function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}`) }
}

const T = 1_000_000

// One per student, however often they rescan.
resetWaiting()
noteWaiting('s1', 'A', 'stu1', T)
noteWaiting('s1', 'A', 'stu1', T + 1000)
noteWaiting('s1', 'A', 'stu1', T + 2000)
check('a student rescanning counts once', waitingSnapshot(T + 3000)[0]?.total === 1)

// Counted per section, with no-section students kept apart.
resetWaiting()
noteWaiting('s1', 'A', 'stu1', T)
noteWaiting('s1', 'A', 'stu2', T)
noteWaiting('s1', 'B', 'stu3', T)
noteWaiting('s1', null, 'stu4', T)
{
  const [w] = waitingSnapshot(T)
  check('total counts everyone', w.total === 4)
  check('section A has two', w.bySection.get('A') === 2)
  check('section B has one', w.bySection.get('B') === 1)
  check('no-section students are counted apart', w.bySection.get(null) === 1)
}

// Busiest session first.
resetWaiting()
noteWaiting('quiet', 'A', 'stu1', T)
noteWaiting('busy', 'A', 'stu2', T)
noteWaiting('busy', 'A', 'stu3', T)
check('busiest session is listed first', waitingSnapshot(T)[0]?.sessionId === 'busy')

// Forgotten after the TTL, refreshed by a rescan.
resetWaiting()
noteWaiting('s1', 'A', 'stu1', T)
noteWaiting('s1', 'A', 'stu2', T + WAITING_TTL_MS - 1000)
{
  const [w] = waitingSnapshot(T + WAITING_TTL_MS + 1)
  check('an old scan is forgotten', w?.total === 1)
}
check('a session with nobody left disappears', waitingSnapshot(T + 3 * WAITING_TTL_MS).length === 0)

// Opening a section clears that section and the no-section students, not the others.
resetWaiting()
noteWaiting('s1', 'A', 'stu1', T)
noteWaiting('s1', 'B', 'stu2', T)
noteWaiting('s1', null, 'stu3', T)
noteOpened('s1', 'A')
{
  const [w] = waitingSnapshot(T)
  check('opening A leaves only B waiting', w?.total === 1 && w.bySection.get('B') === 1)
}
noteOpened('s1', 'B')
check('opening B clears the rest', waitingSnapshot(T).length === 0)

// A whole-class run admits everyone.
resetWaiting()
noteWaiting('s1', 'A', 'stu1', T)
noteWaiting('s1', 'B', 'stu2', T)
noteOpened('s1', null)
check('a whole-class run clears every section', waitingSnapshot(T).length === 0)

// Opening one session does not touch another.
resetWaiting()
noteWaiting('s1', 'A', 'stu1', T)
noteWaiting('s2', 'A', 'stu2', T)
noteOpened('s1', 'A')
check('opening one session leaves another waiting', waitingSnapshot(T)[0]?.sessionId === 's2')

// Getting in anywhere stops a student waiting everywhere.
resetWaiting()
noteWaiting('s1', 'A', 'stu1', T)
noteWaiting('s2', 'A', 'stu1', T)
noteWaiting('s2', 'A', 'stu2', T)
noteAdmitted('stu1')
{
  const snap = waitingSnapshot(T)
  check('an admitted student leaves every list', snap.length === 1 && snap[0].sessionId === 's2' && snap[0].total === 1)
}

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
