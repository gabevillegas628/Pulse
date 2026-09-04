/** Extract a user-facing message from an Axios error response. */
export function apiError(err: unknown, fallback = 'Something went wrong'): string {
  return (
    (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback
  )
}

/**
 * The server's machine-readable refusal code, when it sent one.
 *
 * Only refusals a client must act on carry a code — a closed question is not
 * something to show and move past, it is the page's new state. Matching on the
 * prose in `error` instead would break the moment that wording is edited.
 */
export function apiErrorCode(err: unknown): string | null {
  return (
    (err as { response?: { data?: { code?: string } } })?.response?.data?.code ?? null
  )
}
