import { ReactNode, useEffect } from 'react'
import { Link } from 'react-router-dom'
import PulseMark from '@/components/ui/PulseMark'

export default function StudentLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    const block = (e: Event) => e.preventDefault()
    document.addEventListener('paste', block)
    document.addEventListener('contextmenu', block)
    return () => {
      document.removeEventListener('paste', block)
      document.removeEventListener('contextmenu', block)
    }
  }, [])

  return (
    <div className="min-h-screen bg-canvas flex flex-col">
      <header className="bg-surface border-b border-hairline shrink-0">
        <div className="max-w-md mx-auto px-4 h-12 flex items-center">
          <Link to="/student" className="inline-flex items-center gap-2">
            <PulseMark size={18} />
            <span className="font-extrabold text-ink text-base tracking-tight" style={{ letterSpacing: '-0.02em' }}>Pulse</span>
          </Link>
        </div>
      </header>
      <main className="flex-1 flex flex-col items-center justify-start px-4 pt-8 pb-16">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  )
}
