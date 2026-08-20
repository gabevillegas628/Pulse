import { renderQrCardBase64 } from 'shared'

/**
 * Office.js interop for Pulse Question objects.
 *
 * A "Pulse Question object" is an ordinary picture shape carrying tags that record which
 * question it points at. Tags persist inside the .pptx, so the binding survives save,
 * close, copy, and send.
 *
 * Two deliberate constraints:
 *  - Images are inserted with the Common API `setSelectedDataAsync`, NOT
 *    `ShapeCollection.addPicture`, which is preview-only and marked unfit for production.
 *  - Tags hold only non-secret binding data. Never the auth token: decks get shared.
 */

export const TAG_CLASS_ID = 'PULSE_CLASS_ID'
export const TAG_QUESTION_ID = 'PULSE_QUESTION_ID'
export const TAG_SESSION_ID = 'PULSE_SESSION_ID'
export const TAG_CODE = 'PULSE_CODE'

/** Tag keys are stored uppercase by PowerPoint, and some tag APIs require that casing. */
const upper = (k: string) => k.toUpperCase()

export interface BoundShape {
  slideIndex: number
  slideId: string
  shapeId: string
  questionId: string
  sessionId: string | null
  code: string
  left: number
  top: number
  width: number
  height: number
}

/** Minimum API level: tags need 1.3, shape geometry needs 1.4. */
export function checkSupport(): { ok: boolean; message?: string } {
  if (!Office.context.requirements.isSetSupported('PowerPointApi', '1.3')) {
    return {
      ok: false,
      message:
        'This add-in needs PowerPoint API 1.3 or later. Update Microsoft 365, or use a newer PowerPoint build.',
    }
  }
  if (!Office.context.requirements.isSetSupported('PowerPointApi', '1.4')) {
    return {
      ok: false,
      message:
        'This add-in needs PowerPoint API 1.4 or later to reposition refreshed QR codes. Update Microsoft 365.',
    }
  }
  return { ok: true }
}

/** Presentation-level tag recording which class this deck is bound to. */
export async function getDeckClassId(): Promise<string | null> {
  return PowerPoint.run(async (context) => {
    const tags = context.presentation.tags
    tags.load('items/key, items/value')
    await context.sync()
    return tags.items.find((t) => t.key === TAG_CLASS_ID)?.value ?? null
  })
}

export async function setDeckClassId(classId: string): Promise<void> {
  await PowerPoint.run(async (context) => {
    context.presentation.tags.add(upper(TAG_CLASS_ID), classId)
    await context.sync()
  })
}

/** Every Pulse-tagged shape in the deck, in slide order. */
export async function scanDeck(): Promise<BoundShape[]> {
  return PowerPoint.run(async (context) => {
    const slides = context.presentation.slides
    slides.load('items/id, items/shapes/items/id, items/shapes/items/tags/key, items/shapes/items/tags/value')
    await context.sync()

    const found: BoundShape[] = []
    const geometryTargets: PowerPoint.Shape[] = []

    slides.items.forEach((slide, slideIndex) => {
      for (const shape of slide.shapes.items) {
        const tag = (key: string) => shape.tags.items.find((t) => t.key === upper(key))?.value
        const questionId = tag(TAG_QUESTION_ID)
        const code = tag(TAG_CODE)
        if (!questionId || !code) continue

        found.push({
          slideIndex,
          slideId: slide.id,
          shapeId: shape.id,
          questionId,
          sessionId: tag(TAG_SESSION_ID) ?? null,
          code,
          left: 0,
          top: 0,
          width: 0,
          height: 0,
        })
        shape.load('left, top, width, height')
        geometryTargets.push(shape)
      }
    })

    if (geometryTargets.length === 0) return found
    await context.sync()

    geometryTargets.forEach((shape, i) => {
      found[i].left = shape.left
      found[i].top = shape.top
      found[i].width = shape.width
      found[i].height = shape.height
    })
    return found
  })
}

/** 1-based index of the slide the user is currently on. */
function getSelectedSlideIndex(): Promise<number> {
  return new Promise((resolve, reject) => {
    Office.context.document.getSelectedDataAsync(Office.CoercionType.SlideRange, (result) => {
      if (result.status === Office.AsyncResultStatus.Failed) reject(new Error(result.error.message))
      else resolve((result.value as { slides: { index: number }[] }).slides[0].index)
    })
  })
}

/** Insert a base64 image at the current selection. */
function insertImage(base64: string): Promise<void> {
  return new Promise((resolve, reject) => {
    Office.context.document.setSelectedDataAsync(
      base64,
      { coercionType: Office.CoercionType.Image },
      (result) => {
        if (result.status === Office.AsyncResultStatus.Failed) reject(new Error(result.error.message))
        else resolve()
      }
    )
  })
}

/**
 * The card the professor UI produces, at 2x so it stays sharp when projected.
 * Shared with the web app so a slide and a copy-pasted card look identical.
 */
function renderCard(qrDataUrl: string, code: string, questionText: string): Promise<string> {
  return renderQrCardBase64({ qrDataUrl, accessCode: code, questionText, scale: 2 })
}

async function shapeIdsOnSlide(slideIndex0: number): Promise<Set<string>> {
  return PowerPoint.run(async (context) => {
    const shapes = context.presentation.slides.getItemAt(slideIndex0).shapes
    shapes.load('items/id')
    await context.sync()
    return new Set(shapes.items.map((s) => s.id))
  })
}

/**
 * Insert a QR for `question` on the current slide and tag it.
 *
 * `addPicture` being preview-only means there's no handle on the created shape, so the
 * new shape is identified by diffing slide shape ids before and after the insert.
 */
export async function insertPulseQuestion(opts: {
  qrDataUrl: string
  questionId: string
  sessionId: string
  code: string
  classId: string
  questionText: string
}): Promise<void> {
  const slideIndex1 = await getSelectedSlideIndex()
  const slideIndex0 = slideIndex1 - 1

  const card = await renderCard(opts.qrDataUrl, opts.code, opts.questionText)
  const before = await shapeIdsOnSlide(slideIndex0)
  await insertImage(card)
  const after = await shapeIdsOnSlide(slideIndex0)

  const newIds = [...after].filter((id) => !before.has(id))
  if (newIds.length !== 1) {
    throw new Error(
      'Could not identify the inserted image. Click the slide (not a text box) and try again.'
    )
  }

  await PowerPoint.run(async (context) => {
    const shape = context.presentation.slides.getItemAt(slideIndex0).shapes.getItem(newIds[0])
    shape.tags.add(upper(TAG_QUESTION_ID), opts.questionId)
    shape.tags.add(upper(TAG_SESSION_ID), opts.sessionId)
    shape.tags.add(upper(TAG_CODE), opts.code)
    shape.altTextTitle = 'Pulse question QR code'
    shape.altTextDescription = `Scan to answer. Access code ${opts.code}.`
    context.presentation.tags.add(upper(TAG_CLASS_ID), opts.classId)
    await context.sync()
  })
}

/**
 * Replace a bound shape's image in place, preserving position and size, and re-tag it.
 * Only used when a code could not be adopted onto the question.
 */
export async function restampShape(
  shape: BoundShape,
  qrDataUrl: string,
  newCode: string,
  questionText: string
): Promise<void> {
  const card = await renderCard(qrDataUrl, newCode, questionText)

  // setSelectedDataAsync inserts at the *current selection*, so the target slide has to
  // be selected first. Without this the replacement lands on whatever slide the user
  // happens to be on, and the id diff below then finds nothing.
  await goToSlide(shape.slideIndex)

  await PowerPoint.run(async (context) => {
    context.presentation.slides.getItemAt(shape.slideIndex).shapes.getItem(shape.shapeId).delete()
    await context.sync()
  })

  const before = await shapeIdsOnSlide(shape.slideIndex)
  await insertImage(card)
  const after = await shapeIdsOnSlide(shape.slideIndex)
  const newIds = [...after].filter((id) => !before.has(id))
  if (newIds.length !== 1) throw new Error('Could not identify the replacement image.')

  await PowerPoint.run(async (context) => {
    const created = context.presentation.slides.getItemAt(shape.slideIndex).shapes.getItem(newIds[0])
    created.left = shape.left
    created.top = shape.top
    created.width = shape.width
    created.height = shape.height
    created.tags.add(upper(TAG_QUESTION_ID), shape.questionId)
    if (shape.sessionId) created.tags.add(upper(TAG_SESSION_ID), shape.sessionId)
    created.tags.add(upper(TAG_CODE), newCode)
    created.altTextTitle = 'Pulse question QR code'
    created.altTextDescription = `Scan to answer. Access code ${newCode}.`
    await context.sync()
  })
}

/** Update just the code tag, for when adoption made the image still correct. */
export async function retagCode(shape: BoundShape, code: string): Promise<void> {
  await PowerPoint.run(async (context) => {
    const target = context.presentation.slides
      .getItemAt(shape.slideIndex)
      .shapes.getItem(shape.shapeId)
    target.tags.add(upper(TAG_CODE), code)
    await context.sync()
  })
}

/** Re-point a bound shape at a different question (used by rebind). */
export async function retargetShape(
  shape: BoundShape,
  questionId: string,
  code: string
): Promise<void> {
  await PowerPoint.run(async (context) => {
    const target = context.presentation.slides
      .getItemAt(shape.slideIndex)
      .shapes.getItem(shape.shapeId)
    target.tags.add(upper(TAG_QUESTION_ID), questionId)
    target.tags.add(upper(TAG_CODE), code)
    await context.sync()
  })
}

/** Bring a slide into view so the user can see what a status row refers to. */
export async function goToSlide(slideIndex: number): Promise<void> {
  await PowerPoint.run(async (context) => {
    const slide = context.presentation.slides.getItemAt(slideIndex)
    slide.load('id')
    await context.sync()
    context.presentation.setSelectedSlides([slide.id])
    await context.sync()
  })
}
