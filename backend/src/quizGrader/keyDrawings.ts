/**
 * The professor's own filled-in answer key, cut into one drawing per intermediate.
 *
 * The key is uploaded as a PDF or photo of the quiz form with the answers drawn in (the
 * professor's, not a student's). Each page goes through the vision service like a scan, and
 * every structure box is cut out; a box with ink in it is that intermediate's drawing. The
 * drawings are what suggested checks are written from and tested against (suggest.ts).
 */
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import type { Prisma } from '@prisma/client'
import { prisma } from '../db/index.js'
import type { Layout, PathwayKey } from './content.js'
import { versionPage } from './content.js'
import { contextFor } from './grading.js'
import { createDocument, deleteDocument, documentPage, processImage } from './scans.js'

export interface KeyDrawing {
  /** The layout box it was cut from, and that box as it was then (to tell when boxes move). */
  slotId: string
  box: number[]
  /** 1-based page of the uploaded file. */
  page: number
  ink: number
  /** The crop, base64 PNG. */
  png: string
}

export interface KeyDrawingsData {
  cutAt: string
  pages: number
  items: Record<string, KeyDrawing>
  notes: string[]
}

/** Each structure box of the layout: the box of an intermediate's drawing (not its name). */
export function structureBoxes(layout: Layout, key: PathwayKey): { slotId: string; intermediate: string; box: number[] }[] {
  const out: { slotId: string; intermediate: string; box: number[] }[] = []
  for (const s of layout.slots) {
    const m = /^intermediate\.([^.]+)$/.exec(s.ref)
    if (m && s.box && key.intermediates[m[1]!]) out.push({ slotId: s.id, intermediate: m[1]!, box: s.box })
  }
  return out
}

/** Intermediates whose box has moved since their drawing was cut, or that have a box but no drawing yet. */
export function drawingsOutOfDate(data: KeyDrawingsData, layout: Layout, key: PathwayKey): string[] {
  const now = new Map(structureBoxes(layout, key).map((b) => [b.intermediate, b]))
  return Object.entries(data.items)
    .filter(([id, d]) => { const b = now.get(id); return !b || b.slotId !== d.slotId || JSON.stringify(b.box) !== JSON.stringify(d.box) })
    .map(([id]) => id)
}

/** Cut the uploaded key into drawings, and store them. */
export async function cutKeyDrawings(assessmentId: string): Promise<KeyDrawingsData> {
  const row = await prisma.quizKeyDrawings.findUniqueOrThrow({ where: { assessmentId } })
  const ctx = await contextFor(assessmentId)
  const a = await prisma.quizContent.findUniqueOrThrow({ where: { id: assessmentId }, select: { professorId: true } })
  const layoutRow = await prisma.quizContent.findUnique({
    where: { professorId_kind_slug: { professorId: a.professorId, kind: 'LAYOUT', slug: ctx.assessment.layout } },
    select: { pdf: true },
  })
  if (!layoutRow?.pdf) throw new Error('Upload the blank form (Boxes tab) first: the key is lined up against it.')
  const boxes = structureBoxes(ctx.layout, ctx.key)
  if (!boxes.length) throw new Error('Draw a box for each drawn structure (Boxes tab) first: drawings are cut out with those boxes.')
  const owner = new Map(boxes.map((b) => [b.slotId, b]))
  const names = Object.keys(ctx.assessment.versions)
  // Every version crops every structure box: a key page may have any of them drawn in.
  const versions = names.map((name) => ({ name, page: versionPage(ctx.assessment, name), boxes: boxes.map((b) => ({ id: b.slotId, box: b.box })) }))

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'quiz-key-'))
  const file = path.join(tmp, row.fileName.replace(/[^\w.-]/g, '_') || 'key.pdf')
  await fs.writeFile(file, row.file)
  const notes: string[] = []
  const items: Record<string, KeyDrawing & { rank: number[] }> = {}
  let pages = 0
  try {
    const doc = await createDocument(file, row.fileName)
    pages = doc.pages
    try {
      for (let i = 0; i < doc.pages; i++) {
        const img = await documentPage(doc.id, i)
        let r = await processImage(img, layoutRow.pdf, { versions, version: null })
        const detected = r.version
        if (!r.version) {
          // Answers drawn over every version's tells: any version's printing will do to
          // tell drawing from form, since the boxes are the same.
          r = await processImage(img, layoutRow.pdf, { versions, version: names[0]! })
          if (names.length > 1) notes.push(`Page ${i + 1}: could not tell which version it is; read it as version ${names[0]}.`)
        }
        if (r.match < 0.8) notes.push(`Page ${i + 1} lined up poorly with the blank form (${Math.round(r.match * 100)}% of its lines found); check its drawings.`)
        // A box catches ink from the answers beside it, so a page whose version has the
        // student draw that intermediate is preferred; then the page with more ink in the box.
        // A guessed version proves nothing about which drawings belong to it.
        const drawnHere = new Set(detected ? ctx.assessment.versions[detected]?.structures ?? [] : [])
        for (const c of r.crops) {
          const b = owner.get(c.id)
          if (!b || c.blank) continue
          const rank = [drawnHere.has(b.intermediate) ? 1 : 0, c.ink]
          const had = items[b.intermediate]
          if (had && (rank[0]! < had.rank[0]! || (rank[0] === had.rank[0] && rank[1]! <= had.rank[1]!))) continue
          items[b.intermediate] = { slotId: c.id, box: b.box, page: i + 1, ink: c.ink, png: c.png, rank }
        }
      }
    } finally {
      await deleteDocument(doc.id)
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
  const graded = new Set(Object.values(ctx.assessment.versions).flatMap((v) => v.structures))
  const missing = [...graded].filter((id) => !items[id] && boxes.some((b) => b.intermediate === id))
  if (missing.length) notes.push(`No drawing found for ${missing.map((id) => ctx.key.intermediates[id]?.name ?? id).join(', ')}: its box is empty on every page.`)

  const data: KeyDrawingsData = {
    cutAt: new Date().toISOString(), pages, notes,
    items: Object.fromEntries(Object.entries(items).map(([id, { rank: _, ...d }]) => [id, d])),
  }
  await prisma.quizKeyDrawings.update({ where: { assessmentId }, data: { drawings: data as unknown as Prisma.InputJsonValue } })
  return data
}
