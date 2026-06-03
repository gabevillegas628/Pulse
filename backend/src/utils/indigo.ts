const INDIGO_URL = (process.env.INDIGO_SERVICE_URL ?? 'http://indigoservice.railway.internal').replace(/\/$/, '')

/**
 * Convert a SMILES string to Indigo's canonical SMILES.
 * Falls back to the raw input if the service is unavailable so writes never fail.
 */
export async function canonicalizeSmiles(smiles: string): Promise<string> {
  try {
    const res = await fetch(`${INDIGO_URL}/v2/indigo/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ struct: smiles, output_format: 'chemical/x-smiles' }),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return smiles
    const data = await res.json() as { struct?: string }
    return data.struct?.trim() ?? smiles
  } catch {
    return smiles
  }
}
