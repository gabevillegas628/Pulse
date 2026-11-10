import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

/** Open a PDF once; pages render from the returned document. */
export async function openPdf(bytes: ArrayBuffer) {
  // pdf.js takes ownership of the buffer it is given, so it gets a copy.
  return pdfjs.getDocument({ data: new Uint8Array(bytes.slice(0)) }).promise
}
export type Pdf = Awaited<ReturnType<typeof openPdf>>

/** One page of a PDF drawn to fill its container's width, crisp on high-DPI screens. */
export default function PdfPage({ pdf, page, onAspect }: { pdf: Pdf; page: number; onAspect?: (heightOverWidth: number) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    let task: ReturnType<Awaited<ReturnType<Pdf['getPage']>>['render']> | null = null
    void (async () => {
      try {
        const p = await pdf.getPage(page)
        const base = p.getViewport({ scale: 1 })
        onAspect?.(base.height / base.width)
        const el = canvas.current
        if (!el || cancelled) return
        const width = el.parentElement?.clientWidth ?? 800
        const scale = (width / base.width) * (window.devicePixelRatio || 1)
        const vp = p.getViewport({ scale })
        el.width = vp.width
        el.height = vp.height
        task = p.render({ canvasContext: el.getContext('2d')!, viewport: vp })
        await task.promise
      } catch (e) {
        if (!cancelled && (e as { name?: string }).name !== 'RenderingCancelledException') setError('Could not draw this page of the PDF.')
      }
    })()
    return () => { cancelled = true; task?.cancel() }
  }, [pdf, page, onAspect])

  return error ? <p className="text-sm text-warn p-4">{error}</p> : <canvas ref={canvas} className="block w-full h-auto" />
}
