import { Router, Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { prisma } from '../db/index.js'
import { config } from '../config/index.js'
import { requireProfessor } from '../middleware/auth.middleware.js'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeMathjax from 'rehype-mathjax'
import rehypeRaw from 'rehype-raw'
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize'
import type { Schema } from 'hast-util-sanitize'
import rehypeSlug from 'rehype-slug'
import rehypeStringify from 'rehype-stringify'

const router = Router()

function githubHeaders(): HeadersInit {
  return config.githubToken ? { Authorization: `Bearer ${config.githubToken}` } : {}
}

// ─── Types ────────────────────────────────────────────────────────────────────

interface GitHubFile {
  name: string
  type: 'file' | 'dir' | 'symlink' | 'submodule'
  download_url: string | null
}

interface SearchResult {
  chapterName: string
  downloadUrl: string
  sectionId: string
  sectionTitle: string
  excerpt: string
  occurrenceIndex: number
}

// ─── Markdown → HTML processor ────────────────────────────────────────────────

// Sanitize before rehypeMathjax: at this point math is still simple
// <code class="math-inline/math-display"> nodes, not yet SVG. After sanitization,
// rehypeMathjax converts those trusted nodes to SVG — no SVG schema needed.
const sanitizeSchema: Schema = {
  ...defaultSchema,
  clobber: [],  // don't prefix heading IDs with user-content- (breaks TOC anchors)
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    code: [['className', /^language-./, 'math-inline', 'math-display'] as [string, ...(string | RegExp)[]]],
  },
}

const processor = unified()
  .use(remarkParse)
  .use(remarkMath)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  .use(rehypeRaw)
  .use(rehypeSanitize, sanitizeSchema)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .use(rehypeMathjax, { tex: { packages: { '[+]': ['cancel', 'ams'] } } } as any)
  .use(rehypeSlug)
  .use(rehypeStringify)

// ─── In-memory cache ──────────────────────────────────────────────────────────

interface CacheEntry { html: string; cachedAt: number }
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

// ─── Search helpers ───────────────────────────────────────────────────────────

function stripTags(html: string): string {
  return html
    .replace(/<(svg|mjx-container)[\s\S]*?<\/\1>/gi, ' ')  // remove math/SVG blobs before tag-stripping
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function extractSections(html: string): Array<{ id: string; title: string; text: string }> {
  const sections: Array<{ id: string; title: string; text: string }> = []
  const h2Regex = /<h2[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/h2>/g
  let lastSection: { id: string; title: string; startIndex: number } | null = null
  let firstMatchIndex: number | null = null

  for (const match of html.matchAll(h2Regex)) {
    if (firstMatchIndex === null) firstMatchIndex = match.index ?? 0
    if (lastSection) {
      sections.push({
        id: lastSection.id,
        title: lastSection.title,
        text: stripTags(html.slice(lastSection.startIndex, match.index)),
      })
    }
    lastSection = {
      id: match[1],
      title: stripTags(match[2]),
      startIndex: (match.index ?? 0) + match[0].length,
    }
  }
  if (lastSection) {
    sections.push({ id: lastSection.id, title: lastSection.title, text: stripTags(html.slice(lastSection.startIndex)) })
  }

  // Capture intro content before the first h2
  const introHtml = html.slice(0, firstMatchIndex ?? html.length)
  const introText = stripTags(introHtml)
  if (introText.trim()) {
    const h1Match = introHtml.match(/<h1[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/h1>/)
    sections.unshift({
      id: h1Match?.[1] ?? '',
      title: h1Match ? stripTags(h1Match[2]) : 'Introduction',
      text: introText,
    })
  }

  return sections
}

function buildExcerpt(text: string, idx: number, queryLen: number, prefix = 40, total = 220): string {
  const start = Math.max(0, idx - prefix)
  const end = Math.min(text.length, start + total)
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '')
}

// Returns one result per cluster of occurrences (merging those within proximityThreshold chars).
// occurrenceIndex is the position of this cluster's first occurrence among ALL occurrences in the
// section — used by the frontend TreeWalker to scroll to the right one.
function wholeWordRegex(query: string): RegExp {
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`, 'gi')
}

function findOccurrences(text: string, query: string, proximityThreshold = 300): Array<{ excerpt: string; occurrenceIndex: number }> {
  const results: Array<{ excerpt: string; occurrenceIndex: number }> = []
  const regex = wholeWordRegex(query)
  let lastClusterIdx = -Infinity
  let totalCount = 0
  let match: RegExpExecArray | null

  while ((match = regex.exec(text)) !== null) {
    const idx = match.index
    if (idx - lastClusterIdx > proximityThreshold) {
      results.push({ excerpt: buildExcerpt(text, idx, query.length), occurrenceIndex: totalCount })
      lastClusterIdx = idx
    }
    totalCount++
  }
  return results
}

async function getOrRenderChapter(downloadUrl: string): Promise<string> {
  const cached = cache.get(downloadUrl)
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) return cached.html

  const upstream = await fetch(downloadUrl, { headers: githubHeaders() })
  if (!upstream.ok) throw new Error(`GitHub returned ${upstream.status}`)
  const markdown = await upstream.text()
  const file = await processor.process(markdown.replace(/\\cr\b/g, '\\\\'))
  const html = String(file)
    .replace(
      /<p>(<mjx-container(?:(?!<\/p>)[\s\S])*?<\/mjx-container>)<\/p>/g,
      '<p class="math-display">$1</p>',
    )
    .replace(
      /(<mjx-container\b[^>]*\bdisplay="true"[^>]*>[\s\S]*?<\/mjx-container>)/g,
      '<p class="math-display">$1</p>',
    )
  cache.set(downloadUrl, { html, cachedAt: Date.now() })
  return html
}

// ─── Route ────────────────────────────────────────────────────────────────────

router.get('/textbook/render', async (req, res, next) => {
  try {
    const url = req.query.url as string | undefined
    if (!url) return void res.status(400).json({ error: 'url query param is required' })

    // Only allow GitHub raw URLs
    if (!url.startsWith('https://raw.githubusercontent.com/')) {
      return void res.status(400).json({ error: 'url must be a raw.githubusercontent.com URL' })
    }

    // Track view — fire-and-forget, skip professor requests.
    // The frontend uses the api client so the Authorization header is always present.
    const classId = req.query.classId as string | undefined
    if (classId) {
      const authHeader = req.headers.authorization
      let isProfessor = false
      if (authHeader?.startsWith('Bearer ')) {
        try {
          const payload = jwt.verify(authHeader.slice(7), config.jwtSecret) as { role?: string }
          isProfessor = payload.role === 'professor'
        } catch { /* invalid token — treat as student */ }
      }
      if (!isProfessor) {
        const chapterFilename = url.split('/').pop() ?? url
        prisma.textbookView.create({ data: { classId, chapterFilename } }).catch(() => {})
      }
    }

    // Serve from cache if fresh
    const cached = cache.get(url)
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return void res.json({ html: cached.html })
    }

    // Fetch markdown from GitHub
    const upstream = await fetch(url, { headers: githubHeaders() })
    if (!upstream.ok) {
      return void res.status(upstream.status).json({ error: `GitHub returned ${upstream.status}` })
    }
    const markdown = await upstream.text()

    // MathJax 3 uses \\ as the row separator; \cr is a raw TeX primitive it
    // doesn't handle reliably. Normalize before processing. The source file
    // is unchanged so GitHub (which does support \cr) is unaffected.
    const normalizedMarkdown = markdown.replace(/\\cr\b/g, '\\\\')

    // Render
    const file = await processor.process(normalizedMarkdown)
    // Mark display math for CSS centering. Two patterns appear in practice:
    // 1. <p><mjx-container>…</mjx-container></p> — container lacks display="true"
    // 2. Standalone <mjx-container display="true"> between paragraphs
    // Both get wrapped in <p class="math-display"> so the same CSS rule applies.
    const html = String(file)
      .replace(
        /<p>(<mjx-container(?:(?!<\/p>)[\s\S])*?<\/mjx-container>)<\/p>/g,
        '<p class="math-display">$1</p>',
      )
      .replace(
        /(<mjx-container\b[^>]*\bdisplay="true"[^>]*>[\s\S]*?<\/mjx-container>)/g,
        '<p class="math-display">$1</p>',
      )

    cache.set(url, { html, cachedAt: Date.now() })
    res.json({ html })
  } catch (err) {
    next(err)
  }
})

// ─── Search ───────────────────────────────────────────────────────────────────

router.get('/textbook/search', async (req, res, next) => {
  try {
    const { repo, path: repoPath = '', query } = req.query as Record<string, string>
    if (!repo) return void res.status(400).json({ error: 'repo is required' })
    if (!query || query.trim().length < 2) return void res.status(400).json({ error: 'query must be at least 2 characters' })

    const q = query.trim()
    const segment = repoPath ? `/${repoPath}` : ''
    const listRes = await fetch(`https://api.github.com/repos/${repo}/contents${segment}`, { headers: githubHeaders() })
    if (!listRes.ok) return void res.status(listRes.status).json({ error: `GitHub API error ${listRes.status}` })

    const files = await listRes.json() as GitHubFile[]
    const chapters = (Array.isArray(files) ? files : [])
      .filter(f => f.type === 'file' && f.name.endsWith('.md') && f.download_url)
      .map(f => ({ name: f.name, downloadUrl: f.download_url! }))

    const results: SearchResult[] = []
    const qLower = q.toLowerCase()
    await Promise.all(chapters.map(async (ch) => {
      try {
        const html = await getOrRenderChapter(ch.downloadUrl)
        for (const sec of extractSections(html)) {
          const occurrences = findOccurrences(sec.text, q)
          if (occurrences.length > 0) {
            for (const { excerpt, occurrenceIndex } of occurrences) {
              results.push({ chapterName: ch.name, downloadUrl: ch.downloadUrl, sectionId: sec.id, sectionTitle: sec.title, excerpt, occurrenceIndex })
            }
          } else if (wholeWordRegex(q).test(sec.title)) {
            const preview = sec.text.slice(0, 220)
            results.push({ chapterName: ch.name, downloadUrl: ch.downloadUrl, sectionId: sec.id, sectionTitle: sec.title, excerpt: preview + (sec.text.length > 220 ? '…' : ''), occurrenceIndex: 0 })
          }
        }
      } catch { /* skip chapters that fail to load */ }
    }))

    res.json({ data: results })
  } catch (err) {
    next(err)
  }
})

// ─── Cache clear (professor only) ────────────────────────────────────────────

router.delete('/textbook/cache', requireProfessor, (_req: Request, res: Response, next: NextFunction) => {
  try {
    const size = cache.size
    cache.clear()
    res.json({ data: { cleared: size } })
  } catch (err) {
    next(err)
  }
})

export default router
