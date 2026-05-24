import QRCode from 'qrcode'
import { config } from '../config/index.js'

export async function generateQr(url: string): Promise<string> {
  return QRCode.toDataURL(url, { width: 400, margin: 2 })
}

export async function attachQuestionQrs(
  questions: { id: string; accessCode: string; [key: string]: unknown }[]
) {
  return Promise.all(
    questions.map(async (q) => ({
      ...q,
      qrDataUrl: await generateQr(`${config.baseUrl}/q/code/${q.accessCode}`),
    }))
  )
}
