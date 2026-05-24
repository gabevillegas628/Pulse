import { Router } from 'express'
import { unified } from 'unified'
import remarkParse from 'remark-parse'
import remarkMath from 'remark-math'
import remarkGfm from 'remark-gfm'
import remarkRehype from 'remark-rehype'
import rehypeMathjax from 'rehype-mathjax'
import rehypeRaw from 'rehype-raw'
import rehypeSlug from 'rehype-slug'
import rehypeStringify from 'rehype-stringify'

const router = Router()

// ─── Markdown → HTML processor ────────────────────────────────────────────────

const processor = unified()
  .use(remarkParse)
  .use(remarkMath)
  .use(remarkGfm)
  .use(remarkRehype, { allowDangerousHtml: true })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  .use(rehypeMathjax, { tex: { packages: { '[+]': ['cancel'] } } } as any)
  .use(rehypeRaw)
  .use(rehypeSlug)
  .use(rehypeStringify)

// ─── In-memory cache ──────────────────────────────────────────────────────────

interface CacheEntry { html: string; cachedAt: number }
const cache = new Map<string, CacheEntry>()
const CACHE_TTL_MS = 60 * 60 * 1000 // 1 hour

// ─── Route ────────────────────────────────────────────────────────────────────

router.get('/textbook/render', async (req, res, next) => {
  try {
    const url = req.query.url as string | undefined
    if (!url) return void res.status(400).json({ error: 'url query param is required' })

    // Only allow GitHub raw URLs
    if (!url.startsWith('https://raw.githubusercontent.com/')) {
      return void res.status(400).json({ error: 'url must be a raw.githubusercontent.com URL' })
    }

    // Serve from cache if fresh
    const cached = cache.get(url)
    if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
      return void res.json({ html: cached.html })
    }

    // Fetch markdown from GitHub
    const upstream = await fetch(url)
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
    // rehype-mathjax SVG output doesn't emit display="true" on mjx-container,
    // so we detect display math structurally: a <p> whose entire content is a
    // single mjx-container (no surrounding text). Mark it for CSS centering.
    const html = String(file).replace(
      /<p>\s*(<mjx-container[\s\S]*?<\/mjx-container>)\s*<\/p>/g,
      '<p class="math-display">$1</p>',
    )

    cache.set(url, { html, cachedAt: Date.now() })
    res.json({ html })
  } catch (err) {
    next(err)
  }
})

export default router
