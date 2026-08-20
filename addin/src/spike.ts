/**
 * Phase 0 spike — does a content add-in actually run during a PowerPoint slide show?
 *
 * Everything downstream assumes it does, and the docs never say so outright. This page
 * answers four questions on a real projector:
 *
 *   1. Does it render at all in Slide Show, on Windows and Mac?
 *   2. Does it keep *running* there, or is it frozen as a bitmap? (the ticking counter)
 *   3. Do network calls and a socket connection survive that state?
 *   4. Does it share localStorage with the task pane, so the professor's token carries over?
 *
 * Throwaway. Delete once the answers are recorded.
 */

import { io, type Socket } from 'socket.io-client'

const $ = (id: string) => document.getElementById(id)!
const set = (id: string, text: string, cls?: 'ok' | 'bad' | 'wait') => {
  const el = $(id)
  el.textContent = text
  el.className = `v${cls ? ' ' + cls : ''}`
}

// Random per load, so two instances on different slides can be told apart — and so a
// reload is visible as a new id.
const INSTANCE = Math.random().toString(36).slice(2, 7)

const viewLog: string[] = []
let socket: Socket | null = null

Office.onReady((info) => {
  set('instance', INSTANCE)
  set('host', `${info.host ?? 'unknown'} / ${info.platform ?? 'unknown'}`)

  // A counter that keeps moving proves the page is live rather than a cached image.
  let n = 0
  setInterval(() => {
    n++
    $('tick').textContent = `${n}  ${new Date().toLocaleTimeString()}`
  }, 1000)

  pollView()
  // ActiveViewChanged is documented not to fire in PowerPoint on the web, so poll as
  // well as subscribe — the poll is what we actually trust.
  setInterval(pollView, 1000)
  try {
    Office.context.document.addHandlerAsync(Office.EventType.ActiveViewChanged, () => {
      viewLog.push(`event@${new Date().toLocaleTimeString()}`)
      set('viewlog', viewLog.slice(-4).join('  '))
    })
  } catch {
    /* not fatal — the poll covers it */
  }

  checkToken()
  checkFetch()
  checkSocket()
  checkRequirements()
})

let lastView = ''
function pollView() {
  Office.context.document.getActiveViewAsync((r) => {
    if (r.status === Office.AsyncResultStatus.Failed) {
      set('view', `failed: ${r.error.message}`, 'bad')
      return
    }
    const v = String(r.value)
    set('view', v, v === 'read' ? 'ok' : undefined)
    if (v !== lastView) {
      lastView = v
      viewLog.push(`${v}@${new Date().toLocaleTimeString()}`)
      set('viewlog', viewLog.slice(-4).join('  '))
    }
  })
}

/** Presence only — never print the token itself. */
function checkToken() {
  try {
    const t = localStorage.getItem('pulse_addin_professor_token')
    set('token', t ? `present (${t.length} chars)` : 'absent', t ? 'ok' : 'bad')
  } catch (e) {
    set('token', `localStorage blocked: ${(e as Error).message}`, 'bad')
  }
}

/** A 401 is a pass: it proves the request reached the server. */
async function checkFetch() {
  set('fetch', 'requesting…', 'wait')
  try {
    const res = await fetch('/api/addin/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ codes: ['0000'] }),
    })
    set('fetch', `HTTP ${res.status} (reachable)`, 'ok')
  } catch (e) {
    set('fetch', `failed: ${(e as Error).message}`, 'bad')
  }
}

function checkSocket() {
  set('socket', 'connecting…', 'wait')
  const token = (() => { try { return localStorage.getItem('pulse_addin_professor_token') } catch { return null } })()
  // The server disconnects unauthenticated sockets, so without a token the most we can
  // prove is that the transport itself works.
  socket = io({ path: '/socket.io', auth: { token: token ?? 'none' } })
  socket.on('connect', () => set('socket', `connected ${socket?.id ?? ''}`, 'ok'))
  socket.on('disconnect', (reason) => set('socket', `disconnected: ${reason}`, 'bad'))
  socket.on('connect_error', (err) => set('socket', `error: ${err.message}`, 'bad'))
}

function checkRequirements() {
  const sets = ['1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8']
    .filter((v) => {
      try { return Office.context.requirements.isSetSupported('PowerPointApi', v) } catch { return false }
    })
  set('reqs', sets.length ? `PowerPointApi up to ${sets[sets.length - 1]}` : 'none reported')
}
