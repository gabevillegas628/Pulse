const INDIGO_URL = (process.env.INDIGO_SERVICE_URL ?? 'http://indigoservice.railway.internal').replace(/\/$/, '')

/**
 * Convert any structure format (SMILES, Molfile, etc.) to a canonical InChI string.
 * Throws if the Indigo service is unavailable — callers should propagate the error.
 */
export async function toInchi(struct: string): Promise<string> {
  const res = await fetch(`${INDIGO_URL}/v2/indigo/convert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ struct, output_format: 'chemical/x-inchi' }),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`Indigo service error: ${res.status}`)
  const data = await res.json() as { struct?: string }
  if (!data.struct) throw new Error('Indigo returned empty InChI')
  return data.struct.trim()
}
