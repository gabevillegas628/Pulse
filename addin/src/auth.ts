/**
 * Login dialog for the add-in.
 *
 * Runs in an Office dialog so credentials are entered in an isolated window and only
 * the resulting token is handed back to the task pane via messageParent. The token is
 * never written into the document.
 */

Office.onReady(() => {
  const form = document.getElementById('form') as HTMLFormElement
  const status = document.getElementById('status')!
  const submit = document.getElementById('submit') as HTMLButtonElement

  form.addEventListener('submit', async (e) => {
    e.preventDefault()
    submit.disabled = true
    status.textContent = 'Signing in…'
    status.className = 'status muted'

    const email = (document.getElementById('email') as HTMLInputElement).value
    const password = (document.getElementById('password') as HTMLInputElement).value

    try {
      const res = await fetch('/api/auth/professor/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const body = await res.json().catch(() => null)

      if (!res.ok) {
        status.textContent = body?.error ?? 'Sign in failed'
        status.className = 'status error'
        submit.disabled = false
        return
      }

      const token = body?.data?.token
      if (!token) {
        status.textContent = 'No token returned'
        status.className = 'status error'
        submit.disabled = false
        return
      }

      Office.context.ui.messageParent(JSON.stringify({ token }))
    } catch {
      status.textContent = 'Network error — check your connection'
      status.className = 'status error'
      submit.disabled = false
    }
  })
})
