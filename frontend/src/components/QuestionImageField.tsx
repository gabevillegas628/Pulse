import { useRef, useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import { uploadImage, deleteUpload } from '@/lib/uploadImage'

interface Props {
  value: string | null
  onChange: (url: string | null) => void
  /**
   * Whether replacing or removing should delete the outgoing file straight away.
   *
   * True while composing a question that does not exist yet — nothing else can be
   * pointing at the file, so a discarded upload is pure litter. False when editing a
   * saved question: there the PATCH is what decides, and deleting here would strand
   * the question on a missing file if that save then failed.
   */
  cleanupOnReplace?: boolean
}

export default function QuestionImageField({ value, onChange, cleanupOnReplace = false }: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')

  async function handlePick(file: File) {
    setError('')
    setUploading(true)
    try {
      const url = await uploadImage(file)
      if (cleanupOnReplace && value) await deleteUpload(value)
      onChange(url)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Upload failed')
    } finally {
      setUploading(false)
    }
  }

  async function handleRemove() {
    const outgoing = value
    onChange(null)
    setError('')
    if (cleanupOnReplace && outgoing) await deleteUpload(outgoing)
  }

  return (
    <div className="space-y-2">
      {value ? (
        <div className="flex items-start gap-3">
          <img
            src={value}
            alt=""
            className="max-h-32 rounded-sm border border-hairline object-contain bg-surface-2"
          />
          <div className="flex flex-col gap-1 pt-1">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="text-xs text-signal hover:text-[var(--signal-bright)] disabled:opacity-50 transition-colors text-left"
            >
              {uploading ? 'Uploading…' : 'Replace'}
            </button>
            <button
              type="button"
              onClick={handleRemove}
              className="flex items-center gap-1 text-xs text-muted hover:text-red-500 transition-colors"
            >
              <X size={11} /> Remove
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="flex items-center gap-1.5 text-xs text-muted hover:text-ink border border-dashed border-hairline-strong rounded-sm px-3 py-2 w-full justify-center disabled:opacity-50 transition-colors"
        >
          <ImagePlus size={13} />
          {uploading ? 'Uploading…' : 'Add image (optional)'}
        </button>
      )}

      {error && <p className="text-red-500 text-xs">{error}</p>}

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          if (file) handlePick(file)
          // Cleared so picking the same file twice still fires a change event.
          e.target.value = ''
        }}
      />
    </div>
  )
}
