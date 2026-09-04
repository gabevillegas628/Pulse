/**
 * Renders the Pulse question card — QR plus access code on the left, question text on
 * the right, with the signal-coloured accent bar.
 *
 * BROWSER ONLY. This uses the DOM (canvas, Image), so it must never be called from the
 * backend. It lives in `shared` because both the professor UI (copy to clipboard) and
 * the PowerPoint add-in (insert onto a slide) need to produce a pixel-identical card;
 * keeping two copies of the drawing code guarantees they drift.
 */

export interface QrCardOptions {
  /** QR image as a data URL, from the API. */
  qrDataUrl: string
  /** The 4-digit code printed under the QR. */
  accessCode: string
  /** Question text shown to the right of the divider. */
  questionText: string
  /**
   * Pixel density multiplier. 1 for on-screen use; 2 keeps the card crisp when it is
   * projected from a slide, where a 1x card visibly softens.
   */
  scale?: number
}

/** Draws the card and returns the canvas. Callers decide what to do with it. */
export async function renderQrCard(options: QrCardOptions): Promise<HTMLCanvasElement> {
  const { qrDataUrl, accessCode, questionText, scale = 1 } = options

  const accent = 7, pad = 20, radius = 14, shadowPad = 24
  const qrSize = 140, rightWidth = 260, maxCardH = 300
  // The code is what the room reads; the QR is for the few close enough to scan it.
  // Sized to nearly fill the QR column rather than sit politely under it — at the old
  // 22px, one projected 1672 came back as 1692, 1675 and 1472 in a single lecture.
  const codeTargetSize = 48
  const codeFamily = '"Courier New", monospace'
  const qTextFont = 'bold 20px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
  const lineH = 28

  const img = new Image()
  img.src = qrDataUrl
  await new Promise((resolve, reject) => {
    img.onload = resolve
    img.onerror = () => reject(new Error('Could not load the QR image'))
  })

  const divX = accent + pad + qrSize + pad
  const tx = divX + pad
  const W = tx + rightWidth + pad

  // Word-wrap helper
  const m = document.createElement('canvas').getContext('2d')!
  function wrapText(text: string, maxW: number, font: string): string[] {
    m.font = font
    const lines: string[] = []
    let line = ''
    for (const word of text.split(' ')) {
      const test = line ? line + ' ' + word : word
      if (m.measureText(test).width > maxW && line) { lines.push(line); line = word }
      else line = test
    }
    if (line) lines.push(line)
    return lines
  }

  // Shrink to fit if a code is ever longer than the four digits minted today, so a
  // wider code narrows instead of spilling past the QR column into the divider.
  let codeSize = codeTargetSize
  while (codeSize > 12) {
    m.font = `bold ${codeSize}px ${codeFamily}`
    if (m.measureText(accessCode).width <= qrSize) break
    codeSize--
  }
  const codeFont = `bold ${codeSize}px ${codeFamily}`
  // Derived from the fitted size so the reserved line box cannot drift from the font
  // and clip the code — the failure the previous hardcoded 26 was one edit away from.
  const codeH = Math.ceil(codeSize * 1.2)

  const qLines = wrapText(questionText, rightWidth, qTextFont)
  const leftH = pad + qrSize + 8 + codeH + pad
  const rightH = pad + qLines.length * lineH + pad
  const H = Math.min(Math.max(leftH, rightH), maxCardH)

  // Clip question lines to available height
  const availH = H - pad - pad
  const maxLines = Math.floor(availH / lineH)
  const visibleLines = qLines.slice(0, maxLines)
  if (visibleLines.length < qLines.length && visibleLines.length > 0)
    visibleLines[visibleLines.length - 1] = visibleLines[visibleLines.length - 1].replace(/.{1,3}$/, '…')

  const canvas = document.createElement('canvas')
  canvas.width = (W + shadowPad * 2) * scale
  canvas.height = (H + shadowPad * 2) * scale
  const ctx = canvas.getContext('2d')!
  // Draw in logical units and let the transform handle density, so the layout maths
  // below stays identical regardless of scale.
  ctx.scale(scale, scale)
  const ox = shadowPad, oy = shadowPad

  function roundedRect(x: number, y: number, w: number, h: number, r: number) {
    ctx.beginPath()
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y)
    ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h - r)
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r); ctx.lineTo(x + r, y + h)
    ctx.arcTo(x, y + h, x, y + h - r, r); ctx.lineTo(x, y + r)
    ctx.arcTo(x, y, x + r, y, r); ctx.closePath()
  }

  // White card + shadow
  ctx.save()
  ctx.shadowColor = 'rgba(0,0,0,0.15)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 5
  ctx.fillStyle = 'white'
  roundedRect(ox, oy, W, H, radius); ctx.fill()
  ctx.restore()

  // Border
  ctx.save()
  ctx.strokeStyle = '#d1d5db'; ctx.lineWidth = 2
  roundedRect(ox, oy, W, H, radius); ctx.stroke()
  ctx.restore()

  // Clip content
  ctx.save()
  roundedRect(ox, oy, W, H, radius); ctx.clip()

  // Red accent bar
  ctx.fillStyle = '#ee4d2e'
  ctx.fillRect(ox, oy, accent, H)

  // QR — vertically centered for QR+code block
  const blockH = qrSize + 8 + codeH
  const qrY = oy + (H - blockH) / 2
  ctx.drawImage(img, ox + accent + pad, qrY, qrSize, qrSize)

  // Access code centered below QR
  ctx.fillStyle = '#111827'; ctx.font = codeFont
  ctx.textAlign = 'center'; ctx.textBaseline = 'top'
  ctx.fillText(accessCode, ox + accent + pad + qrSize / 2, qrY + qrSize + 8)

  // Divider
  ctx.strokeStyle = '#e5e7eb'; ctx.lineWidth = 1
  ctx.beginPath()
  ctx.moveTo(ox + divX, oy + pad); ctx.lineTo(ox + divX, oy + H - pad)
  ctx.stroke()

  // Right side — question text, vertically centered
  ctx.textAlign = 'left'; ctx.textBaseline = 'top'
  const textBlockH = visibleLines.length * lineH
  let ry = oy + (H - textBlockH) / 2

  ctx.fillStyle = '#111827'; ctx.font = qTextFont
  for (const line of visibleLines) { ctx.fillText(line, ox + tx, ry); ry += lineH }

  ctx.restore()

  return canvas
}

/** Card as a base64 PNG payload, with no `data:` prefix — what Office wants. */
export async function renderQrCardBase64(options: QrCardOptions): Promise<string> {
  const canvas = await renderQrCard(options)
  return canvas.toDataURL('image/png').replace(/^data:image\/\w+;base64,/, '')
}

/** Card copied to the clipboard as a PNG. */
export async function copyQrCardToClipboard(options: QrCardOptions): Promise<void> {
  const canvas = await renderQrCard(options)
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) throw new Error('Could not render the card')
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
}
