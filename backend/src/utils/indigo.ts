import { AppError } from '../middleware/error.middleware.js'

const INDIGO_URL = (process.env.INDIGO_SERVICE_URL ?? 'http://indigoservice.railway.internal').replace(/\/$/, '')

/**
 * Convert any structure format (Molfile, SMILES, etc.) to FixedH InChI.
 * FixedH InChI is canonical (same string regardless of drawing order) AND
 * preserves exact protonation state via the /f layer — zwitterionic and neutral
 * forms of the same compound produce different strings.
 * Throws a 400 AppError if Indigo rejects the structure itself, and a plain error
 * if the service is unavailable — callers should propagate either.
 */
export async function toInchi(struct: string): Promise<string> {
  const res = await fetch(`${INDIGO_URL}/v2/indigo/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ struct, output_format: 'chemical/x-inchi', options: { 'inchi-options': '/FixedH' } }),
    signal: AbortSignal.timeout(5000),
  })
  // A 400 is Indigo refusing the drawing — an empty canvas, a structure it cannot
  // read — not the service failing. That is the caller's to fix, so it must not
  // leave as a 500 and an exception report.
  if (res.status === 400) throw new AppError('That structure could not be read — check the drawing and try again', 400)
  if (!res.ok) throw new Error(`Indigo service error: ${res.status}`)
  const data = await res.json() as { struct?: string }
  if (!data.struct) throw new Error('Indigo returned empty structure')
  return data.struct.trim()
}
