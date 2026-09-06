import { api } from '@/api/client'
import { apiError } from '@/lib/errors'

/**
 * Send an image to the server and get back the path it was stored at.
 *
 * The returned value is a "/uploads/<name>" path, which is what every imageUrl field
 * expects — the API validates that shape on the way in, so a value from anywhere else
 * will be refused.
 *
 * Throws with the server's own message ("Image must be 5 MB or smaller") so callers can
 * put the real reason on screen rather than a generic failure.
 */
export async function uploadImage(file: File): Promise<string> {
  try {
    const { data } = await api.post<{ url: string }>('/uploads/image', form(file), {
      headers: { 'Content-Type': 'multipart/form-data' },
    })
    return data.url
  } catch (err) {
    throw new Error(apiError(err, 'Upload failed — check the file type and size (max 5 MB)'))
  }
}

/**
 * Discard an image that was uploaded but never saved onto anything.
 *
 * Deliberately silent: this is tidying, and a failure to tidy is not something to
 * interrupt a professor mid-edit for. Passing a path some question does use is
 * harmless — the server counts references before it deletes.
 */
export async function deleteUpload(url: string): Promise<void> {
  try {
    await api.delete('/uploads/image', { data: { url } })
  } catch {
    // Leaves an orphaned file. Cheaper than a dialog nobody can act on.
  }
}

function form(file: File): FormData {
  const f = new FormData()
  f.append('image', file)
  return f
}
