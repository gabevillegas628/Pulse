import {
  ApiError,
  adoptCode,
  getQuestionQr,
  getSession,
  getToken,
  listClasses,
  listSessions,
  proposeRebind,
  setToken,
  verifyCodes,
  type ClassSummary,
  type QuestionSummary,
  type SessionSummary,
  type VerifyResult,
} from './api'
import {
  checkSupport,
  getDeckClassId,
  goToSlide,
  insertPulseQuestion,
  restampShape,
  retagCode,
  retargetShape,
  scanDeck,
  setDeckClassId,
  type BoundShape,
} from './office'

const $ = (id: string) => document.getElementById(id)!
const show = (id: string, visible: boolean) => $(id).classList.toggle('hidden', !visible)

let classes: ClassSummary[] = []
let sessions: SessionSummary[] = []
let questions: QuestionSummary[] = []
let deckClassId: string | null = null

// ─── Boot ─────────────────────────────────────────────────────────────────────

Office.onReady(async (info) => {
  if (info.host !== Office.HostType.PowerPoint) {
    $('app').innerHTML = '<p class="error">This add-in only runs in PowerPoint.</p>'
    return
  }

  const support = checkSupport()
  if (!support.ok) {
    $('app').innerHTML = `<p class="error">${support.message}</p>`
    return
  }

  wireEvents()

  if (!getToken()) {
    showSignedOut()
    return
  }
  await showSignedIn()
})

function wireEvents() {
  $('sign-in').addEventListener('click', signIn)
  $('sign-out').addEventListener('click', () => {
    setToken(null)
    showSignedOut()
  })
  $('class-select').addEventListener('change', onClassChange)
  $('session-select').addEventListener('change', onSessionChange)
  $('insert-btn').addEventListener('click', onInsert)
  $('verify-btn').addEventListener('click', () => void runVerify())
  $('sync-btn').addEventListener('click', onSync)
  $('rebind-btn').addEventListener('click', onRebind)
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Log in through a dialog rather than collecting a password in the task pane, so the
 * add-in never handles credentials directly — it only receives the resulting token.
 */
function signIn() {
  const url = `${window.location.origin}/addin/auth.html`
  Office.context.ui.displayDialogAsync(url, { height: 60, width: 30 }, (result) => {
    if (result.status === Office.AsyncResultStatus.Failed) {
      setStatus('auth-status', result.error.message, 'error')
      return
    }
    const dialog = result.value
    dialog.addEventHandler(Office.EventType.DialogMessageReceived, async (arg) => {
      const message = (arg as { message: string }).message
      dialog.close()
      try {
        const payload = JSON.parse(message) as { token?: string; error?: string }
        if (payload.error || !payload.token) {
          setStatus('auth-status', payload.error ?? 'Sign in failed', 'error')
          return
        }
        setToken(payload.token)
        await showSignedIn()
      } catch {
        setStatus('auth-status', 'Sign in failed', 'error')
      }
    })
  })
}

function showSignedOut() {
  show('signed-out', true)
  show('signed-in', false)
}

async function showSignedIn() {
  show('signed-out', false)
  show('signed-in', true)
  try {
    classes = await listClasses()
    deckClassId = await getDeckClassId()
    renderClassOptions()
    await onClassChange()
    await runVerify()
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showSignedOut()
    setStatus('verify-status', errText(err), 'error')
  }
}

// ─── Picker ───────────────────────────────────────────────────────────────────

function renderClassOptions() {
  const select = $('class-select') as HTMLSelectElement
  select.innerHTML = classes
    .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`)
    .join('')
  // Default to whatever class this deck is already bound to
  if (deckClassId && classes.some((c) => c.id === deckClassId)) select.value = deckClassId
}

async function onClassChange() {
  const classId = (($('class-select') as HTMLSelectElement).value) || null
  const sessionSelect = $('session-select') as HTMLSelectElement
  if (!classId) {
    sessionSelect.innerHTML = ''
    return
  }
  try {
    sessions = await listSessions(classId)
    sessionSelect.innerHTML = sessions
      .map((s) => `<option value="${s.id}">${escapeHtml(s.title)} (${s._count?.questions ?? 0})</option>`)
      .join('')
    await onSessionChange()
  } catch (err) {
    setStatus('insert-status', errText(err), 'error')
  }
}

async function onSessionChange() {
  const sessionId = ($('session-select') as HTMLSelectElement).value
  const questionSelect = $('question-select') as HTMLSelectElement
  if (!sessionId) {
    questionSelect.innerHTML = ''
    return
  }
  try {
    const session = await getSession(sessionId)
    questions = session.questions
    questionSelect.innerHTML = questions
      .map((q, i) => `<option value="${q.id}">Q${i + 1} — ${escapeHtml(questionLabel(q))}</option>`)
      .join('')
  } catch (err) {
    setStatus('insert-status', errText(err), 'error')
  }
}

/** The professor-set title if there is one, else a trimmed snippet of the question text. */
function questionLabel(q: QuestionSummary): string {
  const title = q.title?.trim()
  if (title) return title
  return q.text.length > 50 ? `${q.text.slice(0, 50).trimEnd()}…` : q.text
}

// ─── Insert ───────────────────────────────────────────────────────────────────

async function onInsert() {
  const classId = ($('class-select') as HTMLSelectElement).value
  const sessionId = ($('session-select') as HTMLSelectElement).value
  const questionId = ($('question-select') as HTMLSelectElement).value
  if (!questionId) return

  setStatus('insert-status', 'Inserting…', 'muted')
  try {
    const { qrDataUrl, accessCode, text } = await getQuestionQr(questionId)
    await insertPulseQuestion({
      qrDataUrl,
      questionId,
      sessionId,
      code: accessCode,
      classId,
      questionText: text,
    })
    if (deckClassId !== classId) {
      await setDeckClassId(classId)
      deckClassId = classId
    }
    setStatus('insert-status', `Inserted — code ${accessCode}`, 'ok')
    await runVerify()
  } catch (err) {
    setStatus('insert-status', errText(err), 'error')
  }
}

// ─── Verify ───────────────────────────────────────────────────────────────────

interface Row {
  shape: BoundShape
  result: VerifyResult
}
let lastRows: Row[] = []

async function runVerify(): Promise<void> {
  setStatus('verify-status', 'Checking deck…', 'muted')
  try {
    const shapes = await scanDeck()
    if (shapes.length === 0) {
      lastRows = []
      $('verify-list').innerHTML = ''
      setStatus('verify-status', 'No Pulse questions in this deck yet.', 'muted')
      updateSummary(0, 0)
      return
    }

    const results = await verifyCodes(shapes.map((s) => s.code))
    const byCode = new Map(results.map((r) => [r.code, r]))
    lastRows = shapes.map((shape) => ({ shape, result: byCode.get(shape.code)! }))

    renderVerifyList()
    const stale = lastRows.filter((r) => classify(r).severity !== 'ok').length
    updateSummary(lastRows.length, stale)
    setStatus(
      'verify-status',
      stale === 0
        ? `All ${lastRows.length} slide${lastRows.length !== 1 ? 's' : ''} up to date.`
        : `${stale} of ${lastRows.length} need attention.`,
      stale === 0 ? 'ok' : 'warn'
    )
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return showSignedOut()
    setStatus('verify-status', errText(err), 'error')
  }
}

type Severity = 'ok' | 'warn' | 'error'

/** Turn a shape + API result into something a human can act on. */
function classify(row: Row): { severity: Severity; label: string } {
  const { shape, result } = row
  if (!result || result.status === 'not_found') {
    return { severity: 'error', label: `Code ${shape.code} no longer exists` }
  }
  if (result.question.id !== shape.questionId) {
    return { severity: 'error', label: `Code ${shape.code} now points at a different question` }
  }
  if (deckClassId && result.class.id !== deckClassId) {
    return { severity: 'warn', label: `Belongs to ${result.class.name}, not this deck's class` }
  }
  if (result.session && !result.session.isLive) {
    return { severity: 'ok', label: `${result.session.title} — not open yet` }
  }
  return { severity: 'ok', label: result.session ? `${result.session.title} — live` : 'Homework' }
}

function renderVerifyList() {
  $('verify-list').innerHTML = lastRows
    .map((row, i) => {
      const { severity, label } = classify(row)
      const title =
        row.result?.status === 'ok' ? questionLabel(row.result.question as QuestionSummary) : '—'
      return `
        <li class="row ${severity}" data-index="${i}">
          <span class="slide">Slide ${row.shape.slideIndex + 1}</span>
          <span class="body">
            <span class="title">${escapeHtml(title)}</span>
            <span class="detail">${escapeHtml(label)}</span>
          </span>
          <span class="code">${escapeHtml(row.shape.code)}</span>
        </li>`
    })
    .join('')

  $('verify-list')
    .querySelectorAll('.row')
    .forEach((el) =>
      el.addEventListener('click', () => {
        const idx = Number((el as HTMLElement).dataset.index)
        void goToSlide(lastRows[idx].shape.slideIndex)
      })
    )
}

function updateSummary(total: number, stale: number) {
  const badge = $('summary-badge')
  badge.textContent = stale > 0 ? String(stale) : ''
  badge.classList.toggle('hidden', stale === 0)
  ;($('sync-btn') as HTMLButtonElement).disabled = stale === 0 || total === 0
}

// ─── Sync ─────────────────────────────────────────────────────────────────────

/**
 * Reconcile the deck. Adoption first: give the question the code the deck already has,
 * so the printed image stays correct and nothing in the file changes. Re-stamping is
 * the fallback for codes that are genuinely taken.
 */
async function onSync() {
  const broken = lastRows.filter((r) => classify(r).severity !== 'ok')
  if (broken.length === 0) return

  setStatus('verify-status', `Syncing ${broken.length}…`, 'muted')
  let adopted = 0
  let restamped = 0
  const failures: string[] = []

  for (const row of broken) {
    const { shape } = row
    try {
      // Preferred path: move the deck's code onto the question. No image churn.
      await adoptCode(shape.questionId, shape.code)
      await retagCode(shape, shape.code)
      adopted++
    } catch (err) {
      if (err instanceof ApiError && (err.status === 409 || err.status === 404)) {
        // Code unavailable (or the question is gone) — fall back to re-stamping.
        try {
          const { qrDataUrl, accessCode, text } = await getQuestionQr(shape.questionId)
          await restampShape(shape, qrDataUrl, accessCode, text)
          restamped++
        } catch (inner) {
          failures.push(`Slide ${shape.slideIndex + 1}: ${errText(inner)}`)
        }
      } else {
        failures.push(`Slide ${shape.slideIndex + 1}: ${errText(err)}`)
      }
    }
  }

  const parts = [
    adopted > 0 ? `${adopted} re-pointed (deck unchanged)` : null,
    restamped > 0 ? `${restamped} image${restamped !== 1 ? 's' : ''} replaced` : null,
    failures.length > 0 ? `${failures.length} failed` : null,
  ].filter(Boolean)

  setStatus('verify-status', parts.join(' · ') || 'Nothing to do', failures.length ? 'warn' : 'ok')
  if (failures.length) $('verify-detail').textContent = failures.join('\n')
  await runVerify()
}

// ─── Rebind ───────────────────────────────────────────────────────────────────

/**
 * After duplicating a class for a new term, re-point the whole deck in one step.
 * The backend proposes a mapping by session title + question order; this confirms it,
 * then adopts each old code onto its new question so no image needs replacing.
 */
async function onRebind() {
  const toClassId = ($('class-select') as HTMLSelectElement).value
  if (!deckClassId) {
    setStatus('rebind-status', 'This deck has no Pulse questions to re-bind yet.', 'warn')
    return
  }
  if (deckClassId === toClassId) {
    setStatus('rebind-status', 'Pick the class you want to re-bind to, then try again.', 'warn')
    return
  }

  setStatus('rebind-status', 'Building mapping…', 'muted')
  try {
    const proposal = await proposeRebind(deckClassId, toClassId)
    const ok = window.confirm(
      `Re-bind this deck from "${proposal.from.name}" to "${proposal.to.name}"?\n\n` +
        `${proposal.matched} question${proposal.matched !== 1 ? 's' : ''} matched, ` +
        `${proposal.unmatched} unmatched.\n\n` +
        `Matched slides keep their current QR image.`
    )
    if (!ok) {
      setStatus('rebind-status', 'Cancelled', 'muted')
      return
    }

    const shapes = await scanDeck()
    const byCode = new Map(proposal.mappings.map((m) => [m.fromCode, m]))
    let moved = 0
    const failures: string[] = []

    for (const shape of shapes) {
      const mapping = byCode.get(shape.code)
      if (!mapping?.to) continue
      try {
        await adoptCode(mapping.to.questionId, shape.code)
        await retargetShape(shape, mapping.to.questionId, shape.code)
        moved++
      } catch (err) {
        failures.push(`Slide ${shape.slideIndex + 1}: ${errText(err)}`)
      }
    }

    await setDeckClassId(toClassId)
    deckClassId = toClassId
    setStatus(
      'rebind-status',
      `Re-bound ${moved} slide${moved !== 1 ? 's' : ''}${failures.length ? `, ${failures.length} failed` : ''}`,
      failures.length ? 'warn' : 'ok'
    )
    if (failures.length) $('verify-detail').textContent = failures.join('\n')
    await runVerify()
  } catch (err) {
    setStatus('rebind-status', errText(err), 'error')
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setStatus(id: string, text: string, kind: 'ok' | 'warn' | 'error' | 'muted') {
  const el = $(id)
  el.textContent = text
  el.className = `status ${kind}`
}

function errText(err: unknown): string {
  if (err instanceof ApiError) return err.message
  if (err instanceof Error) return err.message
  return 'Something went wrong'
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )
}
