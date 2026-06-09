import { useState, useEffect, useRef } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, ChevronRight, Maximize2, Menu, Minimize2, RotateCcw, Search, X } from 'lucide-react'

const NARROW_BREAKPOINT = 768

function useIsNarrow() {
  const [narrow, setNarrow] = useState(() => window.innerWidth < NARROW_BREAKPOINT)
  useEffect(() => {
    const handler = () => setNarrow(window.innerWidth < NARROW_BREAKPOINT)
    window.addEventListener('resize', handler)
    return () => window.removeEventListener('resize', handler)
  }, [])
  return narrow
}
import { contentsApiUrl, filenameToTitle, chapterSortKey } from '@/lib/textbook'
import { api } from '@/api/client'

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

interface Section {
  id: string
  title: string
}

interface SearchResult {
  chapterName: string
  downloadUrl: string
  sectionId: string
  sectionTitle: string
  excerpt: string
}

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay)
    return () => clearTimeout(t)
  }, [value, delay])
  return debounced
}

function HighlightedExcerpt({ text, query }: { text: string; query: string }) {
  const parts = text.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return (
    <span>
      {parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase()
          ? <strong key={i} className="font-semibold text-ink">{part}</strong>
          : part
      )}
    </span>
  )
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
  collapsed,
  onToggleCollapse,
  contentWidth,
  onWidthChange,
  fontSize,
  onFontSizeChange,
  viewCounts,
  sections,
  repo,
  path,
  onScrollToSection,
}: {
  chapters: Chapter[]
  selectedName: string | null
  onSelect: (ch: Chapter) => void
  expanded: boolean
  onToggleExpand: () => void
  collapsed: boolean
  onToggleCollapse: () => void
  contentWidth: number
  onWidthChange: (w: number) => void
  fontSize: FontSize
  onFontSizeChange: (s: FontSize) => void
  viewCounts?: Record<string, number>
  sections?: Section[]
  repo: string
  path: string
  onScrollToSection: (id: string, query?: string) => void
}) {
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const debouncedQuery = useDebounce(searchQuery, 300)

  const { data: searchResults, isFetching: searchFetching } = useQuery<SearchResult[]>({
    queryKey: ['textbook-search', repo, path, debouncedQuery],
    queryFn: () =>
      api.get('/textbook/search', { params: { repo, path, query: debouncedQuery } })
        .then((r) => r.data.data as SearchResult[]),
    enabled: debouncedQuery.length >= 2,
    staleTime: 2 * 60 * 1000,
  })

  function handleSearchResultClick(result: SearchResult) {
    const chapter = chapters.find((c) => c.name === result.chapterName)
    if (chapter) {
      onSelect(chapter)
      onScrollToSection(result.sectionId, debouncedQuery)
    }
  }

  const showResults = debouncedQuery.length >= 2

  return (
    <>
      {/* Permanent w-10 strip — always in flow so content width never shifts */}
      <aside className="w-10 shrink-0 bg-surface border-r border-hairline flex flex-col items-center py-3 gap-3">
        <button
          onClick={onToggleCollapse}
          className="text-muted hover:text-ink transition-colors"
          title={collapsed ? 'Show chapters' : 'Hide chapters'}
        >
          <Menu size={16} />
        </button>
        {chapters.map((ch) => (
          <button
            key={ch.name}
            onClick={() => { onSelect(ch); onToggleCollapse() }}
            className={`w-2 h-2 rounded-full shrink-0 transition-colors ${
              ch.name === selectedName ? 'bg-signal' : 'bg-hairline hover:bg-hairline-strong'
            }`}
            title={filenameToTitle(ch.name)}
          />
        ))}
      </aside>

      {/* Expanded overlay panel — left-0 so -translate-x-full clears the strip completely */}
      <aside className={`absolute left-0 top-0 bottom-0 w-64 z-10 bg-surface border-r border-hairline shadow-lg flex flex-col transition-transform duration-200 ease-in-out ${collapsed ? '-translate-x-full pointer-events-none' : 'translate-x-0'}`}>
          <div className="px-4 py-3 border-b border-hairline flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2">
              <button
                onClick={onToggleCollapse}
                className="text-muted hover:text-ink transition-colors"
                title="Collapse sidebar"
              >
                <Menu size={14} />
              </button>
              <p className="text-xs font-semibold text-muted uppercase tracking-wider">Chapters</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => { setSearchOpen(o => !o); setSearchQuery('') }}
                className={`transition-colors ${searchOpen ? 'text-signal' : 'text-muted hover:text-ink'}`}
                title={searchOpen ? 'Close search' : 'Search'}
              >
                <Search size={14} />
              </button>
              <button
                onClick={onToggleExpand}
                className="text-muted hover:text-ink transition-colors"
                title={expanded ? 'Exit fullscreen' : 'Fullscreen'}
              >
                {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
              </button>
            </div>
          </div>

          {searchOpen && (
            <div className="px-3 py-2 border-b border-hairline shrink-0">
              <div className="relative">
                <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                <input
                  autoFocus
                  type="text"
                  placeholder="Search textbook…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={(e) => e.key === 'Escape' && setSearchOpen(false)}
                  className="w-full pl-7 pr-3 py-1.5 text-xs bg-surface-2 border border-hairline rounded-sm text-ink placeholder:text-muted focus:outline-none focus:border-signal"
                />
              </div>
            </div>
          )}

          <nav className="py-2 overflow-y-auto flex-1">
            {showResults ? (
              searchFetching ? (
                <p className="px-4 py-3 text-xs text-muted">Searching…</p>
              ) : !searchResults || searchResults.length === 0 ? (
                <p className="px-4 py-3 text-xs text-muted">No results for "{debouncedQuery}"</p>
              ) : (
                searchResults.map((result, i) => (
                  <button
                    key={`${result.chapterName}-${result.sectionId}-${i}`}
                    onClick={() => handleSearchResultClick(result)}
                    className="w-full text-left px-4 py-2.5 hover:bg-surface-2 transition-colors border-b border-hairline last:border-0"
                  >
                    <p className="text-xs font-medium text-signal truncate">{result.sectionTitle}</p>
                    <p className="text-[10px] text-muted mt-0.5 truncate">{filenameToTitle(result.chapterName)}</p>
                    <p className="text-xs text-ink-2 mt-1 line-clamp-3 leading-relaxed"><HighlightedExcerpt text={result.excerpt} query={debouncedQuery} /></p>
                  </button>
                ))
              )
            ) : (
              chapters.map((ch) => {
                const isActive = ch.name === selectedName
                return (
                  <div key={ch.name}>
                    <button
                      onClick={() => onSelect(ch)}
                      className={`w-full text-left px-4 py-2.5 flex items-center justify-between gap-2 transition-colors ${
                        isActive
                          ? 'bg-signal-soft text-signal'
                          : 'text-ink-2 hover:bg-surface-2'
                      }`}
                    >
                      <span className="text-sm leading-snug flex-1">{filenameToTitle(ch.name)}</span>
                      <span className="shrink-0 flex items-center gap-1">
                        {viewCounts && (
                          <span className="text-[10px] font-medium text-muted tabular-nums font-mono">
                            {viewCounts[ch.name] ?? 0}
                          </span>
                        )}
                        {isActive && <ChevronRight size={13} className="text-signal" />}
                      </span>
                    </button>
                    {isActive && sections && sections.length > 0 && (
                      <div className="pb-1">
                        {sections.map((sec) => (
                          <button
                            key={sec.id}
                            onClick={() => document.getElementById(sec.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                            className="w-full text-left pl-7 pr-4 py-1 text-xs text-ink-3 hover:text-signal hover:bg-surface-2 transition-colors flex items-center gap-2"
                          >
                            <span className="w-1 h-1 rounded-full bg-hairline-strong shrink-0 mt-px" />
                            <span className="truncate">{sec.title}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </nav>
          {/* Width + font size controls */}
          <div className="px-4 py-3 border-t border-hairline shrink-0 space-y-3">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-xs text-muted">Text width</p>
                <span className="text-xs font-medium text-muted tabular-nums font-mono">{contentWidth}px</span>
              </div>
              <input
                type="range"
                min={400}
                max={1100}
                step={20}
                value={contentWidth}
                onChange={(e) => onWidthChange(Number(e.target.value))}
                className="w-full accent-[var(--signal)]"
              />
            </div>
            <div>
              <p className="text-xs text-muted mb-1.5">Text size</p>
              <div className="flex rounded-sm border border-hairline overflow-hidden">
                {FONT_SIZES.map((s) => (
                  <button
                    key={s.value}
                    onClick={() => onFontSizeChange(s.value)}
                    className={`flex-1 text-xs py-1.5 transition-colors ${
                      fontSize === s.value
                        ? 'bg-signal text-white font-medium'
                        : 'text-ink-2 hover:bg-surface-2'
                    }`}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </aside>
    </>
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
  classId,
  onSectionsLoaded,
  scrollToSection,
  highlightQuery,
  onScrolled,
}: {
  name: string
  downloadUrl: string
  contentWidth: number
  fontSize: FontSize
  expanded: boolean
  onToggleExpand: () => void
  classId?: string
  onSectionsLoaded?: (sections: Section[]) => void
  scrollToSection?: string | null
  highlightQuery?: string | null
  onScrolled?: () => void
}) {
  const { data: html, isLoading, isError } = useQuery<string>({
    queryKey: ['textbook-chapter', downloadUrl],
    queryFn: () =>
      api.get('/textbook/render', { params: { url: downloadUrl, ...(classId ? { classId } : {}) } })
        .then((r) => r.data.html as string),
    staleTime: 5 * 60 * 1000,
  })

  useEffect(() => {
    if (!html || !onSectionsLoaded) return
    const doc = new DOMParser().parseFromString(html, 'text/html')
    const sections = Array.from(doc.querySelectorAll('h2'))
      .map((h) => ({ id: h.id, title: h.textContent?.trim() ?? '' }))
      .filter((s) => s.id && s.title)
    onSectionsLoaded(sections)
  }, [html]) // eslint-disable-line react-hooks/exhaustive-deps

  const contentRef = useRef<HTMLDivElement>(null)

  // Scroll to search result
  useEffect(() => {
    if (!html || !scrollToSection) return
    requestAnimationFrame(() => {
      let target: Element | null = null

      if (highlightQuery && contentRef.current) {
        const sectionEl = document.getElementById(scrollToSection)
        const q = highlightQuery.toLowerCase()
        const walker = document.createTreeWalker(contentRef.current, NodeFilter.SHOW_TEXT)
        let node: Node | null
        while ((node = walker.nextNode())) {
          if (!node.textContent?.toLowerCase().includes(q)) continue
          if (sectionEl && !(sectionEl.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue
          let ancestor: Element | null = node.parentElement
          let inMath = false
          while (ancestor) {
            const tag = ancestor.nodeName.toLowerCase()
            if (tag === 'svg' || tag === 'mjx-container') { inMath = true; break }
            ancestor = ancestor.parentElement
          }
          if (inMath) continue
          let el: Element | null = node.parentElement
          while (el && getComputedStyle(el).display.startsWith('inline')) el = el.parentElement
          target = el
          break
        }
      }

      ;(target ?? document.getElementById(scrollToSection))?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      onScrolled?.()
    })
  }, [html, scrollToSection]) // eslint-disable-line react-hooks/exhaustive-deps

  // Highlight all occurrences of search term via CSS Custom Highlight API
  useEffect(() => {
    CSS.highlights.delete('textbook-search')
    if (!highlightQuery || !contentRef.current || !html) return

    const q = highlightQuery.toLowerCase()
    const ranges: Range[] = []
    const walker = document.createTreeWalker(contentRef.current, NodeFilter.SHOW_TEXT)
    let node: Node | null

    while ((node = walker.nextNode())) {
      let ancestor: Element | null = node.parentElement
      let inMath = false
      while (ancestor) {
        const tag = ancestor.nodeName.toLowerCase()
        if (tag === 'svg' || tag === 'mjx-container') { inMath = true; break }
        ancestor = ancestor.parentElement
      }
      if (inMath) continue

      const text = node.textContent ?? ''
      const textLower = text.toLowerCase()
      let offset = 0
      while (true) {
        const idx = textLower.indexOf(q, offset)
        if (idx === -1) break
        const range = new Range()
        range.setStart(node, idx)
        range.setEnd(node, idx + q.length)
        ranges.push(range)
        offset = idx + 1
      }
    }

    if (ranges.length > 0) CSS.highlights.set('textbook-search', new Highlight(...ranges))
    return () => { CSS.highlights.delete('textbook-search') }
  }, [html, highlightQuery])

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        Loading…
      </div>
    )
  }

  if (isError || html == null) {
    return (
      <div className="flex-1 flex items-center justify-center text-red-500 text-sm px-8 text-center">
        Could not load "{filenameToTitle(name)}". Check your internet connection.
      </div>
    )
  }

  return (
    <article className="flex-1 flex flex-col overflow-hidden">
      {/* Chapter header bar */}
      <div className="flex items-center justify-between px-8 py-3 border-b border-hairline shrink-0">
        <p className="text-sm font-semibold text-ink-2 truncate pr-4">{filenameToTitle(name)}</p>
        <button
          onClick={onToggleExpand}
          className="flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-sm border border-hairline text-sm text-ink-2 hover:bg-surface-2 hover:border-hairline-strong transition-colors"
        >
          {expanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
          {expanded ? 'Exit fullscreen' : 'Fullscreen'}
        </button>
      </div>
      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto px-8 py-10" style={{ maxWidth: contentWidth }}>
          <div
            ref={contentRef}
            className="textbook-prose"
            style={{ fontSize }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </article>
  )
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState() {
  return (
    <div className="flex-1 flex items-center justify-center text-muted">
      <div className="text-center">
        <BookOpen size={40} className="mx-auto mb-3 text-muted opacity-40" />
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
  collapsed,
  onToggleCollapse,
  contentWidth,
  onWidthChange,
  fontSize,
  onFontSizeChange,
  classId,
  viewCounts,
  repo,
  path,
}: {
  chapters: Chapter[]
  selectedName: string | null
  onSelect: (ch: Chapter) => void
  expanded: boolean
  onToggleExpand: () => void
  collapsed: boolean
  onToggleCollapse: () => void
  contentWidth: number
  onWidthChange: (w: number) => void
  fontSize: FontSize
  onFontSizeChange: (s: FontSize) => void
  classId?: string
  viewCounts?: Record<string, number>
  repo: string
  path: string
}) {
  const [sections, setSections] = useState<Section[]>([])
  const [pendingSection, setPendingSection] = useState<string | null>(null)
  const [highlightQuery, setHighlightQuery] = useState<string | null>(null)
  useEffect(() => { setSections([]); setHighlightQuery(null) }, [selectedName])

  const selectedChapter = chapters.find((c) => c.name === selectedName) ?? null
  return (
    <div className="relative flex flex-1 overflow-hidden">
      <ChapterSidebar
        chapters={chapters}
        selectedName={selectedName}
        onSelect={onSelect}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        collapsed={collapsed}
        onToggleCollapse={onToggleCollapse}
        contentWidth={contentWidth}
        onWidthChange={onWidthChange}
        fontSize={fontSize}
        onFontSizeChange={onFontSizeChange}
        viewCounts={viewCounts}
        sections={sections}
        repo={repo}
        path={path}
        onScrollToSection={(id, query) => { setPendingSection(id); setHighlightQuery(query ?? null) }}
      />
      {!collapsed && (
        <div className="absolute inset-0 left-64 z-[9]" onClick={onToggleCollapse} />
      )}
      {selectedChapter ? (
        <ChapterContent
          name={selectedChapter.name}
          downloadUrl={selectedChapter.downloadUrl}
          contentWidth={contentWidth}
          fontSize={fontSize}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          classId={classId}
          onSectionsLoaded={setSections}
          scrollToSection={pendingSection}
          highlightQuery={highlightQuery}
          onScrolled={() => setPendingSection(null)}
        />
      ) : (
        <EmptyState />
      )}
    </div>
  )
}

// ─── Main component ───────────────────────────────────────────────────────────

interface TextbookPageProps {
  repo: string
  path: string      // '' for root, 'chapters' for subfolder
  branch?: string   // unused — branch comes from GitHub's download_url
  classId?: string
  viewCounts?: Record<string, number>
}

export default function TextbookPage({ repo, path, classId, viewCounts }: TextbookPageProps) {
  const [searchParams, setSearchParams] = useSearchParams()
  const selectedName = searchParams.get('chapter')
  const [expanded, setExpanded] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [contentWidth, setContentWidth] = useState(672)
  const [fontSize, setFontSize] = useState<FontSize>('1rem')
  const isNarrow = useIsNarrow()

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
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
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

  if (isNarrow) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center px-8 text-center bg-gray-900">
        <RotateCcw size={40} className="text-white/60 mb-5" />
        <p className="text-white text-lg font-semibold mb-2">Rotate your device</p>
        <p className="text-white/60 text-sm leading-relaxed">
          The textbook needs a wider screen. Try landscape mode or open it on a tablet or computer.
        </p>
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
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(c => !c)}
        contentWidth={contentWidth}
        onWidthChange={setContentWidth}
        fontSize={fontSize}
        onFontSizeChange={setFontSize}
        classId={classId}
        viewCounts={viewCounts}
        repo={repo}
        path={path}
      />

      {/* Fullscreen overlay */}
      {expanded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          {/* Close on backdrop click */}
          <div className="absolute inset-0" onClick={() => setExpanded(false)} />

          {/* Modal panel */}
          <div
            className="relative bg-surface rounded-[14px] shadow-2xl overflow-hidden flex"
            style={{ width: '95vw', height: '95vh' }}
          >
            {/* X button in top-right corner */}
            <button
              onClick={() => setExpanded(false)}
              className="absolute top-3 right-3 z-10 text-muted hover:text-ink bg-surface rounded-full p-1 shadow"
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
              collapsed={sidebarCollapsed}
              onToggleCollapse={() => setSidebarCollapsed(c => !c)}
              contentWidth={contentWidth}
              onWidthChange={setContentWidth}
              fontSize={fontSize}
              onFontSizeChange={setFontSize}
              classId={classId}
              viewCounts={viewCounts}
              repo={repo}
              path={path}
            />
          </div>
        </div>
      )}
    </>
  )
}
