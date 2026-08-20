import QRCode from 'qrcode'
import { config } from '../config/index.js'

export async function generateQr(url: string): Promise<string> {
  return QRCode.toDataURL(url, { width: 400, margin: 2 })
}

/**
 * The URL a question's QR code points at.
 *
 * Always code-based, never id-based. The access code is the layer of indirection that
 * lets a printed slide survive being re-pointed at a different question row — see the
 * code swap in the class duplication route. An id-based QR bypasses that indirection
 * and silently goes stale, so every QR in the system must come from here.
 */
export function questionQrUrl(accessCode: string): string {
  return `${config.baseUrl}/q/code/${accessCode}`
}

/** QR data URL for a single question. */
export async function generateQuestionQr(accessCode: string): Promise<string> {
  return generateQr(questionQrUrl(accessCode))
}

export async function attachQuestionQrs(
  questions: { id: string; accessCode: string; [key: string]: unknown }[]
) {
  return Promise.all(
    questions.map(async (q) => ({
      ...q,
      qrDataUrl: await generateQuestionQr(q.accessCode),
    }))
  )
}
