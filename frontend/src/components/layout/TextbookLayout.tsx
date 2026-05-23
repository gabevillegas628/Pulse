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
    <div className={`min-h-screen bg-gray-50 flex flex-col ${className ?? ''}`}>
      {/* Header */}
      <header className="bg-white border-b border-gray-200 shrink-0">
        <div className="max-w-screen-xl mx-auto px-4 h-14 flex items-center gap-3">
          <Link
            to={backHref}
            className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors"
          >
            <ArrowLeft size={15} />
            {backLabel}
          </Link>
          <span className="text-gray-300">|</span>
          <div className="flex items-center gap-1.5 text-sm font-semibold text-primary-700">
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
