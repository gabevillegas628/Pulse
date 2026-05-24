/** Extract a user-facing message from an Axios error response. */
export function apiError(err: unknown, fallback = 'Something went wrong'): string {
  return (
    (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback
  )
}
