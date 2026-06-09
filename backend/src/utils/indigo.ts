const INDIGO_URL = (process.env.INDIGO_SERVICE_URL ?? 'http://indigoservice.railway.internal').replace(/\/$/, '')

/**
 * Convert any structure format (Molfile, SMILES, etc.) to FixedH InChI.
 * FixedH InChI is canonical (same string regardless of drawing order) AND
 * preserves exact protonation state via the /f layer — zwitterionic and neutral
 * forms of the same compound produce different strings.
 * Throws if the Indigo service is unavailable — callers should propagate the error.
 */
export async function toInchi(struct: string): Promise<string> {
  const res = await fetch(`${INDIGO_URL}/v2/indigo/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ struct, output_format: 'chemical/x-inchi', options: { 'inchi-options': '/FixedH' } }),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`Indigo service error: ${res.status}`)
  const data = await res.json() as { struct?: string }
  if (!data.struct) throw new Error('Indigo returned empty structure')
  return data.struct.trim()
}
