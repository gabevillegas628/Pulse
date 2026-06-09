import { api } from '@/api/client'

/** Fetch a CSV endpoint (with auth) and trigger a browser download. */
export async function downloadCsv(apiPath: string, filename: string): Promise<void> {
  const res = await api.get(apiPath, { responseType: 'blob' })
  const url = window.URL.createObjectURL(new Blob([res.data], { type: 'text/csv' }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  window.URL.revokeObjectURL(url)
}
