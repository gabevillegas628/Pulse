import { useState, useEffect } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import ReactMarkdown from 'react-markdown'
import remarkMath from 'remark-math'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import rehypeSlug from 'rehype-slug'
import { BookOpen, ChevronRight, Maximize2, Minimize2, X } from 'lucide-react'
import { contentsApiUrl, filenameToTitle, chapterSortKey } from '@/lib/textbook'

// ─── Types ────────────────────────────────────────────────────────────────────

interface GitHubFile {
  name: string
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  download_url: string | null
}

interface Chapter {
  name: string
  downloadUrl: string
}

// ─── Chapter list sidebar ─────────────────────────────────────────────────────

const FONT_SIZES = [
  { label: 'Normal', value: '1rem' },
  { label: 'Medium', value: '1.125rem' },
  { label: 'Large', value: '1.25rem' },
] as const
type FontSize = typeof FONT_SIZES[number]['value']

function ChapterSidebar({
  chapters,
  selectedName,
  onSelect,
  expanded,
  onToggleExpand,
  contentWidth,
  onWidthChange,
  fontSize,
  onFontSizeChange,
}: {
  chapters: Chapter[]
  selectedName: string | null
  onSelect: (ch: Chapter) => void
  expanded: boolean
  onToggleExpand: () => void
  contentWidth: number
  onWidthChange: (w: number) => void
  fontSize: FontSize
  onFontSizeChange: (s: FontSize) => void
}) {
  return (
    <aside className="w-64 shrink-0 bg-white border-r border-gray-200 flex flex-col">
      <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between shrink-0">
        <p className="text-xs font-semibold text-gray-400 uppercase tracking-wider">Chapters</p>
        <button
          onClick={onToggleExpand}
          className="text-gray-400 hover:text-gray-700 transition-colors"
          title={expanded ? 'Exit fullscreen' : 'Fullscreen'}
        >
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </div>
      <nav className="py-2 overflow-y-auto flex-1">
        {chapters.map((ch) => {
          const isActive = ch.name === selectedName
          return (
            <button
              key={ch.name}
              onClick={() => onSelect(ch)}
              className={`w-full text-left px-4 py-2.5 flex items-center justify-between transition-colors ${
                isActive
                  ? 'bg-primary-50 text-primary-700'
                  : 'text-gray-700 hover:bg-gray-50'
              }`}
            >
              <span className="text-sm leading-snug">{filenameToTitle(ch.name)}</span>
              {isActive && <ChevronRight size={13} className="shrink-0 text-primary-400" />}
            </button>
          )
        })}
      </nav>
      {/* Width + font size controls */}
      <div className="px-4 py-3 border-t border-gray-100 shrink-0 space-y-3">
        <div>
          <div className="flex items-center justify-between mb-1.5">
            <p className="text-xs text-gray-400">Text width</p>
            <span className="text-xs font-medium text-gray-500 tabular-nums">{contentWidth}px</span>
          </div>
          <input
            type="range"
            min={400}
            max={1100}
            step={20}
            value={contentWidth}
            onChange={(e) => onWidthChange(Number(e.target.value))}
            className="w-full accent-primary-600"
          />
        </div>
        <div>
          <p className="text-xs text-gray-400 mb-1.5">Text size</p>
          <div className="flex rounded-lg border border-gray-200 overflow-hidden">
            {FONT_SIZES.map((s) => (
              <button
                key={s.value}
                onClick={() => onFontSizeChange(s.value)}
                className={`flex-1 text-xs py-1.5 transition-colors ${
                  fontSize === s.value
                    ? 'bg-primary-600 text-white font-medium'
                    : 'text-gray-600 hover:bg-gray-50'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </aside>
  )
}

// ─── Chapter content pane ─────────────────────────────────────────────────────

function ChapterContent({
  name,
  downloadUrl,
  contentWidth,
  fontSize,
  expanded,
  onToggleExpand,
}: {
  name: string
  downloadUrl: string
  contentWidth: number
  fontSize: FontSize
  expanded: boolean
  onToggleExpand: () => void
}) {
  const { data: markdown, isLoading, isError } = useQuery<string>({
    queryKey: ['textbook-chapter', downloadUrl],
    queryFn: () =>
      fetch(downloadUrl).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      }),
    staleTime: 5 * 60 * 1000,
  })

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Loading…
      </div>
    )
  }

  if (isError || markdown == null) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-500 text-sm px-8 text-center">
        Could not load "{filenameToTitle(name)}". Check your internet connection.
      </div>
    )
  }

  return (
    <article className="flex-1 flex flex-col overflow-hidden">
      {/* Chapter header bar */}
      <div className="flex items-center justify-between px-8 py-3 border-b border-gray-100 shrink-0">
        <p className="text-sm font-semibold text-gray-700 truncate pr-4">{filenameToTitle(name)}</p>
        <button
          onClick={onToggleExpand}
          className="flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg border border-gray-200 text-sm text-gray-600 hover:bg-gray-50 hover:border-gray-300 transition-colors"
        >
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          {expanded ? 'Exit fullscreen' : 'Fullscreen'}
        </button>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto px-8 py-10" style={{ maxWidth: contentWidth }}>
          <div className="textbook-prose" style={{ fontSize }}>
            <ReactMarkdown
              remarkPlugins={[remarkMath, remarkGfm]}
              rehypePlugins={[rehypeKatex, rehypeRaw, rehypeSlug]}
            >
              {markdown}
            </ReactMarkdown>
          </div>
        </div>
      </div>
    </article>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center text-gray-400">
      <div className="text-center">
        <BookOpen size={40} className="mx-auto mb-3 text-gray-300" />
        <p className="text-sm">Select a chapter to start reading.</p>
      </div>
    </div>
  )
}

// ─── Reader (sidebar + content) ───────────────────────────────────────────────

function Reader({
  chapters,
  selectedName,
  onSelect,
  expanded,
  onToggleExpand,
  contentWidth,
  onWidthChange,
  fontSize,
  onFontSizeChange,
}: {
  chapters: Chapter[]
  selectedName: string | null
  onSelect: (ch: Chapter) => void
  expanded: boolean
  onToggleExpand: () => void
  contentWidth: number
  onWidthChange: (w: number) => void
  fontSize: FontSize
  onFontSizeChange: (s: FontSize) => void
}) {
  const selectedChapter = chapters.find((c) => c.name === selectedName) ?? null
  return (
    <>
      <ChapterSidebar
        chapters={chapters}
        selectedName={selectedName}
        onSelect={onSelect}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        contentWidth={contentWidth}
        onWidthChange={onWidthChange}
        fontSize={fontSize}
        onFontSizeChange={onFontSizeChange}
      />
      {selectedChapter ? (
        <ChapterContent name={selectedChapter.name} downloadUrl={selectedChapter.downloadUrl} contentWidth={contentWidth} fontSize={fontSize} expanded={expanded} onToggleExpand={onToggleExpand} />
      ) : (
        <EmptyState />
      )}
    </>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface TextbookPageProps {
  repo: string
  path: string      // '' for root, 'chapters' for subfolder
  branch?: string   // unused — branch comes from GitHub's download_url
}

export default function TextbookPage({ repo, path }: TextbookPageProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedName = searchParams.get('chapter')
  const [expanded, setExpanded] = useState(false)
  const [contentWidth, setContentWidth] = useState(672)
  const [fontSize, setFontSize] = useState<FontSize>('1rem')

  // Close on Escape
  useEffect(() => {
    if (!expanded) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setExpanded(false) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [expanded])

  const { data: chapters, isLoading, isError } = useQuery<GitHubFile[], Error, Chapter[]>({
    queryKey: ['textbook-chapters', repo, path],
    queryFn: (): Promise<GitHubFile[]> =>
      fetch(contentsApiUrl(repo, path)).then((r) => {
        if (!r.ok) throw new Error(`GitHub API error ${r.status}`)
        return r.json()
      }),
    staleTime: 5 * 60 * 1000,
    select: (raw) =>
      (Array.isArray(raw) ? raw : [])
        .filter((f) => f.type === 'file' && f.name.endsWith('.md') && f.download_url)
        .sort((a, b) => chapterSortKey(a.name) - chapterSortKey(b.name))
        .map((f) => ({ name: f.name, downloadUrl: f.download_url! })),
  })

  function selectChapter(ch: Chapter) {
    setSearchParams({ chapter: ch.name }, { replace: false })
  }

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Loading chapters…
      </div>
    )
  }

  if (isError || !chapters) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-500 text-sm p-8 text-center">
        Could not load chapters from GitHub. Make sure the repo is public and the name is correct.
      </div>
    )
  }

  return (
    <>
      {/* Normal (inline) view */}
      <Reader
        chapters={chapters}
        selectedName={selectedName}
        onSelect={selectChapter}
        expanded={expanded}
        onToggleExpand={() => setExpanded(true)}
        contentWidth={contentWidth}
        onWidthChange={setContentWidth}
        fontSize={fontSize}
        onFontSizeChange={setFontSize}
      />

      {/* Fullscreen overlay */}
      {expanded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          {/* Close on backdrop click */}
          <div className="absolute inset-0" onClick={() => setExpanded(false)} />

          {/* Modal panel */}
          <div
            className="relative bg-white rounded-xl shadow-2xl overflow-hidden flex"
            style={{ width: '95vw', height: '95vh' }}
          >
            {/* X button in top-right corner */}
            <button
              onClick={() => setExpanded(false)}
              className="absolute top-3 right-3 z-10 text-gray-400 hover:text-gray-700 bg-white rounded-full p-1 shadow"
              title="Close (Esc)"
            >
              <X size={16} />
            </button>

            <Reader
              chapters={chapters}
              selectedName={selectedName}
              onSelect={selectChapter}
              expanded={expanded}
              onToggleExpand={() => setExpanded(false)}
              contentWidth={contentWidth}
              onWidthChange={setContentWidth}
              fontSize={fontSize}
              onFontSizeChange={setFontSize}
            />
          </div>
        </div>
      )}
    </>
  )
}
