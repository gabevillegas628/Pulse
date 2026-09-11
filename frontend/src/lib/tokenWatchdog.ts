/**
 * Watches the professor's sign-in leave storage and reports who took it.
 *
 * On 9 Sep a sign-in died mid-session and the token was gone before anyone could look at
 * it. Reconstructing the rest took a night of production logs and still did not answer the
 * only question that mattered — what removed the key. Nothing observes that transition, and
 * by the time a 401 makes it visible the evidence has already been overwritten.
 *
 * Three signals separate the three possible actors, and between them they are exhaustive:
 *
 *   - `noteTokenClear` — our own code called setProfessorToken(null), and we keep the stack.
 *   - the `storage` event — another tab did it. It fires only in *other* tabs, never in the
 *     one that made the change, and carries the URL of the page responsible.
 *   - neither, in which case the browser did it, and the canaries say whether the whole
 *     store went or only this key. The IndexedDB twin separates a localStorage eviction
 *     from a profile-wide clear.
 *
 * What it watches is "the professor's sign-in", not one key. The token lives under
 * `professor_token` in a browser and `pulse_addin_professor_token` inside Office, and
 * `storeRenewedToken` picks between them at write time. The first version of this file
 * watched only the first key, so every renewal on a /present surface — which has only the
 * add-in key — recorded a write and then read the other key's absence as a disappearance.
 * That produced hundreds of false alarms on 11 Sep, at a rate that could have crowded a
 * real report out of the limiter.
 *
 * Reports go out by sendBeacon so they survive the tab closing, and land in the server log
 * without anyone having to be holding devtools open at the time.
 */

const PROFESSOR_KEY = 'professor_token'
const ADDIN_KEY = 'pulse_addin_professor_token'
const CANARY_KEY = 'pulse_storage_canary'
const IDB_NAME = 'pulse-diag'
const IDB_STORE = 'canary'
const POLL_MS = 3000
/** How long an attribution stays fresh. Long enough to cover a poll, short enough not to
 *  blame an unrelated clear from a minute ago for a disappearance we just noticed. */
const ATTRIBUTION_TTL_MS = 15000

interface TokenFacts {
  key: string | null
  tail: string | null
  iat: number | null
  exp: number | null
  writtenAt: number | null
}

let facts: TokenFacts = { key: null, tail: null, iat: null, exp: null, writtenAt: null }
let appClear: { at: number; stack: string } | null = null
let otherTab: { at: number; url: string } | null = null
let lastSeen = false
let started = false

/** Every read and write here is wrapped: storage can throw outright in a blocked context,
 *  and a diagnostic that breaks the app it is diagnosing is worse than no diagnostic. */
function safeGet(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function safeSet(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* nothing to do about it */ }
}

/** Wherever the sign-in currently lives, in the precedence getProfessorToken uses. */
function heldKey(): string | null {
  if (safeGet(PROFESSOR_KEY) != null) return PROFESSOR_KEY
  if (safeGet(ADDIN_KEY) != null) return ADDIN_KEY
  return null
}

function decode(token: string): { iat: number | null; exp: number | null } {
  try {
    const part = token.split('.')[1]
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    const p = JSON.parse(json) as { iat?: number; exp?: number }
    return { iat: p.iat ?? null, exp: p.exp ?? null }
  } catch {
    return { iat: null, exp: null }
  }
}

function keyCount(): number {
  try { return localStorage.length } catch { return 0 }
}

function idb(mode: IDBTransactionMode): Promise<IDBObjectStore | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1)
      req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE) }
      req.onsuccess = () => {
        try { resolve(req.result.transaction(IDB_STORE, mode).objectStore(IDB_STORE)) }
        catch { resolve(null) }
      }
      req.onerror = () => resolve(null)
    } catch { resolve(null) }
  })
}

async function writeIdbCanary(): Promise<void> {
  const store = await idb('readwrite')
  try { store?.put(new Date().toISOString(), 'canary') } catch { /* ignore */ }
}

function readIdbCanary(): Promise<boolean> {
  return new Promise((resolve) => {
    void idb('readonly').then((store) => {
      if (!store) return resolve(false)
      try {
        const req = store.get('canary')
        req.onsuccess = () => resolve(Boolean(req.result))
        req.onerror = () => resolve(false)
      } catch { resolve(false) }
    })
  })
}

function fresh(mark: { at: number } | null): boolean {
  return mark != null && Date.now() - mark.at < ATTRIBUTION_TTL_MS
}

async function report(event: 'boot' | 'token-vanished'): Promise<void> {
  const body = {
    event,
    at: new Date().toISOString(),
    path: location.pathname.slice(0, 200),
    // Which key held the sign-in when it was last written. Without it a report cannot be
    // read at all: an add-in surface and a browser tab look identical otherwise.
    key: facts.key,
    byApp: fresh(appClear),
    appStack: fresh(appClear) ? appClear!.stack.slice(0, 1200) : null,
    byOtherTab: fresh(otherTab) ? otherTab!.url.slice(0, 300) : null,
    canaryLocal: safeGet(CANARY_KEY) != null,
    canaryIdb: await readIdbCanary(),
    keyCount: keyCount(),
    tokenTail: facts.tail,
    tokenIat: facts.iat,
    tokenExp: facts.exp,
    ageSec: facts.writtenAt == null ? null : Math.round((Date.now() - facts.writtenAt) / 1000),
    visibility: document.visibilityState,
  }
  try {
    navigator.sendBeacon(
      '/api/client-diag',
      new Blob([JSON.stringify(body)], { type: 'application/json' })
    )
  } catch { /* a report that cannot be sent is not worth an exception */ }
}

/**
 * Called by the api client whenever a professor token is stored, with the key it went to.
 *
 * The key is a parameter rather than an assumption. Assuming it is exactly what produced
 * the false-alarm flood: a write is only evidence of presence in the key it landed in.
 */
export function noteTokenWrite(key: string, token: string): void {
  const { iat, exp } = decode(token)
  facts = { key, tail: token.slice(-6), iat, exp, writtenAt: Date.now() }
  lastSeen = safeGet(key) != null
  safeSet(CANARY_KEY, new Date().toISOString())
  void writeIdbCanary()
}

/** Called by the api client whenever our own code removes a professor token. */
export function noteTokenClear(): void {
  appClear = { at: Date.now(), stack: new Error('token cleared').stack ?? 'no stack' }
}

export function startTokenWatchdog(): void {
  if (started) return
  started = true

  const held = heldKey()
  lastSeen = held != null
  const hadCanary = safeGet(CANARY_KEY) != null

  if (held) {
    facts = { ...facts, key: held }
    if (!hadCanary) {
      // A sign-in that predates this build has no recorded facts; plant the canaries anyway
      // so the next disappearance can still say whether the store went with it.
      safeSet(CANARY_KEY, new Date().toISOString())
      void writeIdbCanary()
    }
  }

  // Boot is only worth a line when the load is itself evidence: this device wrote a token
  // at some point and has none now, so a disappearance happened while nothing was watching
  // — a tab closed mid-lecture, or a build without this file. Reporting every load instead
  // would be one log line per page view, for no signal at all.
  if (!lastSeen && hadCanary) void report('boot')

  window.addEventListener('storage', (e) => {
    // key === null is the whole store being cleared by another tab.
    if (e.key !== null && e.key !== PROFESSOR_KEY && e.key !== ADDIN_KEY) return
    if (e.newValue == null) otherTab = { at: Date.now(), url: e.url ?? 'unknown' }
  })

  window.setInterval(() => {
    const present = heldKey() != null
    if (lastSeen && !present) void report('token-vanished')
    lastSeen = present
  }, POLL_MS)
}
