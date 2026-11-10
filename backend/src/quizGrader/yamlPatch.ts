/**
 * Apply an edit to a YAML file by splicing only the text that changed.
 *
 * Content (keys, layouts, assessments) is stored as its YAML source, comments and hand
 * formatting included, because keys must round-trip to YAML losslessly and an export
 * should diff cleanly against the file it came from. Re-rendering a parsed document
 * would not do: the yaml library normalises spacing and bracket padding on every line,
 * so adding one alias would show up as a hundred-line diff.
 *
 * So an edit is the whole new value (plain JSON, as the editor holds it), compared
 * against the document node by node, and each difference becomes a text edit at that
 * node's source range:
 *   - a changed scalar is replaced in place;
 *   - a changed flow collection (`[a, b]`, `{ x: 1 }`) is re-rendered in place, keeping
 *     its bracket padding;
 *   - a key added to or removed from a block map, or an item added to or removed from a
 *     block list, is a line inserted or deleted at the right indentation.
 * The result is re-parsed and checked against the requested value. If the splice cannot
 * express a change, the whole document is re-rendered instead: comments survive, and
 * `method` says so.
 */
import { Document, isMap, isScalar, isSeq, parse, parseDocument, type Node, type Pair, type YAMLMap, type YAMLSeq } from 'yaml'

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

export interface PatchResult {
  text: string
  /** 'splice': only changed text was touched. 'rewrite': the fallback re-rendered it all. */
  method: 'unchanged' | 'splice' | 'rewrite'
}

/** Lists under these keys are written one item per line; other lists of scalars inline. */
const BLOCK_LIST_KEYS = new Set(['features', 'slots'])

const RENDER = { lineWidth: 0, flowCollectionPadding: false } as const

const isPlainObject = (v: unknown): v is Record<string, Json> => typeof v === 'object' && v !== null && !Array.isArray(v)
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

interface Edit { start: number; end: number; text: string }

class Unsupported extends Error {}

export function patchYaml(src: string, next: unknown): PatchResult {
  const doc = parseDocument(src)
  if (doc.errors.length) throw new Error(`Stored YAML no longer parses: ${doc.errors[0]!.message}`)
  const current = doc.toJS() as Json
  if (equal(current, next)) return { text: src, method: 'unchanged' }

  try {
    const edits: Edit[] = []
    diff(src, doc, doc.contents as Node, current, next as Json, null, edits)
    const text = applyEdits(src, edits)
    if (equal(parse(text), next)) return { text, method: 'splice' }
  } catch (e) {
    if (!(e instanceof Unsupported)) throw e
  }

  // Fallback: merge the new value into the document model and re-render everything.
  // Comments attached to surviving nodes are kept; formatting is normalised.
  const fresh = parseDocument(src)
  fresh.contents = merge(fresh, fresh.contents as Node, next as Json, null) as typeof fresh.contents
  const text = fresh.toString(RENDER)
  if (!equal(parse(text), next)) throw new Error('Could not write the edited YAML faithfully')
  return { text, method: 'rewrite' }
}

// ── Diff ───────────────────────────────────────────────────────────────────────

function diff(src: string, doc: Document, node: Node | null, oldV: Json, newV: Json, key: string | null, edits: Edit[], inFlow = false): void {
  if (equal(oldV, newV)) return
  if (!node || !node.range) throw new Unsupported()

  // Flow collections keeping their shape (same length, same keys) are edited item by
  // item; one that grows, shrinks or changes keys is re-rendered whole, keeping its
  // bracket padding.
  if ((isSeq(node) || isMap(node)) && node.flow) {
    if (isSeq(node) && Array.isArray(oldV) && Array.isArray(newV) && oldV.length === newV.length) {
      newV.forEach((v, i) => diff(src, doc, node.items[i] as Node, oldV[i]!, v, key, edits, true))
      return
    }
    if (isMap(node) && isPlainObject(oldV) && isPlainObject(newV) && equal(Object.keys(oldV), Object.keys(newV))) {
      for (const p of node.items as Pair[]) diff(src, doc, p.value as Node, oldV[keyOf(p)]!, newV[keyOf(p)]!, keyOf(p), edits, true)
      return
    }
    const padded = /^[[{] /.test(src.slice(node.range[0], node.range[1]))
    edits.push({ start: node.range[0], end: node.range[1], text: renderFlow(newV, padded) })
    return
  }

  if (isScalar(node)) {
    if (typeof newV === 'object' && newV !== null) {
      // A scalar became a collection (`box: null` → a box): write it inline.
      edits.push({ start: node.range[0], end: node.range[1], text: renderFlow(newV, false) })
      return
    }
    // Inside [] or {}, commas and colons need quoting that a bare scalar would not.
    edits.push({ start: node.range[0], end: node.range[1], text: inFlow ? renderFlow([newV], false).slice(1, -1) : renderScalar(newV) })
    return
  }

  if (isMap(node) && isPlainObject(oldV) && isPlainObject(newV)) return diffBlockMap(src, doc, node, oldV, newV, edits)
  if (isSeq(node) && Array.isArray(oldV) && Array.isArray(newV)) return diffBlockSeq(src, doc, node, oldV, newV, key, edits)
  throw new Unsupported()
}

const keyOf = (p: Pair) => String(isScalar(p.key) ? p.key.value : p.key)

function diffBlockMap(src: string, doc: Document, node: YAMLMap, oldV: Record<string, Json>, newV: Record<string, Json>, edits: Edit[]) {
  const pairs = node.items as Pair[]
  for (const p of pairs) {
    const k = keyOf(p)
    if (!(k in newV)) {
      const [start, end] = pairSpan(src, p)
      edits.push({ start, end, text: '' })
    } else {
      diff(src, doc, p.value as Node, oldV[k]!, newV[k]!, k, edits)
    }
  }

  const added = Object.keys(newV).filter((k) => !(k in oldV))
  if (!added.length) return
  const last = pairs[pairs.length - 1]
  if (!last) throw new Unsupported()
  const indent = column(src, (last.key as Node).range![0])
  // Keep number-looking keys (pathway step numbers) as numbers, like their siblings.
  const numericKeys = pairs.every((p) => isScalar(p.key) && typeof p.key.value === 'number')
  const block = added
    .map((k) => renderBlock({ [k]: newV[k]! }, numericKeys && /^\d+$/.test(k)))
    .join('')
  edits.push({ start: pairSpan(src, last)[1], end: pairSpan(src, last)[1], text: indentLines(block, indent) })
}

function diffBlockSeq(src: string, doc: Document, node: YAMLSeq, oldV: Json[], newV: Json[], key: string | null, edits: Edit[]) {
  const items = node.items as Node[]
  // Pure removals (new is old with some items gone) delete just those lines.
  const kept = subsequenceMatch(oldV, newV)
  if (kept) {
    items.forEach((it, i) => { if (!kept.has(i)) { const [s, e] = itemSpan(src, it); edits.push({ start: s, end: e, text: '' }) } })
    return
  }
  // Otherwise edit pairwise, then add or delete at the end.
  const n = Math.min(oldV.length, newV.length)
  for (let i = 0; i < n; i++) diff(src, doc, items[i]!, oldV[i]!, newV[i]!, key, edits)
  for (let i = n; i < oldV.length; i++) { const [s, e] = itemSpan(src, items[i]!); edits.push({ start: s, end: e, text: '' }) }
  if (newV.length > oldV.length) {
    const last = items[items.length - 1]
    if (!last) throw new Unsupported()
    const lineStart = src.lastIndexOf('\n', last.range![0] - 1) + 1
    const dash = src.indexOf('-', lineStart)
    const indent = dash - lineStart
    const padded = /^[[{] /.test(src.slice(last.range![0], last.range![1]))
    const text = newV.slice(n).map((v) => `${' '.repeat(indent)}- ${renderItem(v, key, padded)}\n`).join('')
    const at = itemSpan(src, last)[1]
    edits.push({ start: at, end: at, text })
  }
}

/** Indices of `old` kept, if `next` is `old` with only deletions; otherwise null. */
function subsequenceMatch(old: Json[], next: Json[]): Set<number> | null {
  if (next.length >= old.length) return null
  const kept = new Set<number>()
  let j = 0
  for (let i = 0; i < old.length && j < next.length; i++) if (equal(old[i], next[j])) { kept.add(i); j++ }
  return j === next.length ? kept : null
}

// ── Source positions ───────────────────────────────────────────────────────────

const column = (src: string, pos: number) => pos - (src.lastIndexOf('\n', pos - 1) + 1)

/** From the start of the line to just past the newline ending the line `pos` is on. */
function toLineEnd(src: string, pos: number) {
  if (pos > 0 && src[pos - 1] === '\n') return pos
  const nl = src.indexOf('\n', pos)
  return nl < 0 ? src.length : nl + 1
}

function pairSpan(src: string, p: Pair): [number, number] {
  const k = p.key as Node
  const v = p.value as Node | null
  const start = src.lastIndexOf('\n', k.range![0] - 1) + 1
  const endPos = v?.range ? v.range[1] : k.range![1]
  return [start, toLineEnd(src, endPos)]
}

function itemSpan(src: string, it: Node): [number, number] {
  const start = src.lastIndexOf('\n', it.range![0] - 1) + 1
  return [start, toLineEnd(src, it.range![1])]
}

function applyEdits(src: string, edits: Edit[]) {
  let out = src
  for (const e of [...edits].sort((a, b) => b.start - a.start || b.end - a.end)) out = out.slice(0, e.start) + e.text + out.slice(e.end)
  return out
}

const indentLines = (text: string, n: number) =>
  text.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n')

// ── Rendering ──────────────────────────────────────────────────────────────────

function renderScalar(v: Json): string {
  return new Document(v).toString(RENDER).trimEnd()
}

function renderFlow(v: Json, padded: boolean): string {
  const d = new Document()
  d.contents = d.createNode(v, { flow: true })
  return d.toString({ ...RENDER, flowCollectionPadding: padded }).trimEnd()
}

/** One list item, styled like a newly written seed file. */
function renderItem(v: Json, key: string | null, padded: boolean): string {
  if (typeof v !== 'object' || v === null) return renderScalar(v)
  if (key === 'slots' || Array.isArray(v)) return renderFlow(v, padded)
  return renderBlock(v, false).trimEnd().split('\n').join('\n  ')
}

/** A block of `key: value` lines in the seed files' house style. */
function renderBlock(v: Record<string, Json>, numericKey: boolean): string {
  const d = new Document()
  d.contents = styled(d, v, null)
  let text = d.toString(RENDER)
  if (numericKey) text = text.replace(/^"(\d+)":/, '$1:')
  return text.endsWith('\n') ? text : text + '\n'
}

/** Lists of scalars inline (`accept: [a, b]`), except the keys kept one-per-line. */
function styled(d: Document, v: Json, key: string | null): Node {
  if (Array.isArray(v)) {
    const scalarsOnly = v.every((x) => typeof x !== 'object' || x === null || (Array.isArray(x) && x.every((y) => typeof y !== 'object')))
    if (scalarsOnly && !BLOCK_LIST_KEYS.has(key ?? '')) return d.createNode(v, { flow: true }) as Node
    const seq = d.createNode([]) as YAMLSeq
    for (const x of v) seq.items.push(key === 'slots' && isPlainObject(x) ? (d.createNode(x, { flow: true }) as Node) : styled(d, x, null))
    return seq
  }
  if (isPlainObject(v)) {
    const map = d.createNode({}) as YAMLMap
    for (const [k, x] of Object.entries(v)) map.items.push(d.createPair(/^\d+$/.test(k) ? Number(k) : k, styled(d, x, k)) as Pair)
    return map
  }
  return d.createNode(v) as Node
}

/** Fallback: carry existing nodes (and their comments) over where the value is unchanged. */
function merge(d: Document, node: Node | null, v: Json, key: string | null): Node {
  if (node && equal((node as { toJS?: (doc: Document) => unknown }).toJS?.(d) ?? null, v)) return node
  if (node && isMap(node) && isPlainObject(v)) {
    const items: Pair[] = []
    for (const [k, x] of Object.entries(v)) {
      const existing = (node.items as Pair[]).find((p) => keyOf(p) === k)
      const value = merge(d, (existing?.value as Node) ?? null, x, k)
      if (existing) { existing.value = value; items.push(existing) } else items.push(d.createPair(/^\d+$/.test(k) ? Number(k) : k, value) as Pair)
    }
    node.items = items
    return node
  }
  return styled(d, v, key)
}
