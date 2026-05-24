/** Extract a short plain-text preview from a RichText JSON string or plain text. */
export function questionPreview(text: string): string {
  try {
    const doc = JSON.parse(text)
    const first = doc?.content?.[0]?.content?.[0]?.text ?? ''
    return first.length > 52 ? first.slice(0, 52) + '…' : first || '(empty)'
  } catch {
    return text.length > 52 ? text.slice(0, 52) + '…' : text || '(empty)'
  }
}
