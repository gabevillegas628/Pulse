import { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, BookOpen } from 'lucide-react'

interface TextbookLayoutProps {
  children: ReactNode
  backHref: string
  backLabel: string
  className?: string
}

export default function TextbookLayout({ children, backHref, backLabel, className }: TextbookLayoutProps) {
  return (
    <div className={`min-h-screen bg-canvas flex flex-col ${className ?? ''}`}>
      {/* Header */}
      <header className="bg-surface border-b border-hairline shrink-0">
        <div className="max-w-screen-xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link
            to={backHref}
            className="flex items-center gap-1.5 text-sm text-muted hover:text-ink transition-colors"
          >
            <ArrowLeft size={15} />
            {backLabel}
          </Link>
          <span className="text-hairline-strong">|</span>
          <div className="flex items-center gap-1.5 text-sm font-semibold text-ink-2">
            <BookOpen size={15} />
            Textbook
          </div>
        </div>
      </header>

      {/* Page body — fills remaining height */}
      <div className="flex-1 flex overflow-hidden">
        {children}
      </div>
    </div>
  )
}
