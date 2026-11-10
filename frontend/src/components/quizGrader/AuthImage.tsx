import { useEffect, useRef, useState } from 'react'
import { api } from '@/api/client'
import { cn } from '@/lib/utils'

/**
 * An image from an authenticated API route. Scans are student work, so they are never
 * public URLs an <img> could load directly: this fetches with the sign-in token, once the
 * image scrolls near the screen, and shows it from a blob URL.
 */
export default function AuthImage({ src, alt, className, eager }: { src: string; alt: string; className?: string; eager?: boolean }) {
  const holder = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(!!eager)
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (visible || !holder.current) return
    const io = new IntersectionObserver(([e]) => { if (e?.isIntersecting) setVisible(true) }, { rootMargin: '400px' })
    io.observe(holder.current)
    return () => io.disconnect()
  }, [visible])

  useEffect(() => {
    if (!visible) return
    let made: string | null = null
    let cancelled = false
    setFailed(false)
    api.get(src, { responseType: 'blob' })
      .then((r) => { if (!cancelled) { made = URL.createObjectURL(r.data as Blob); setUrl(made) } })
      .catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true; if (made) URL.revokeObjectURL(made) }
  }, [src, visible])

  return (
    <div ref={holder} className={cn('bg-surface-2', className)}>
      {url ? <img src={url} alt={alt} className="block w-full h-auto" /> : (
        <div className="w-full h-full min-h-16 flex items-center justify-center text-xs text-muted">{failed ? 'Not available' : ''}</div>
      )}
    </div>
  )
}
