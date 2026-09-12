import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Editor } from 'ketcher-react'
import { RemoteStructServiceProvider } from 'ketcher-core'
import type { Ketcher } from 'ketcher-core'
import Card from '@/components/ui/Card'
import StructureRenderer from '@/components/StructureRenderer'
import { X } from 'lucide-react'

/** Indigo, behind the app's own authenticated proxy. */
const structServiceProvider = new RemoteStructServiceProvider('/api/indigo')

interface Props {
  /** The stored key: an InChI string, or null when none is set. */
  value: string | null
  /**
   * Save a molfile as the new key, or null to clear it. The caller owns the request;
   * the backend converts whatever it is handed to InChI before storing.
   */
  onSave: (molfile: string | null) => void
  pending?: boolean
  disabled?: boolean
}

/**
 * Set a structure question's answer key by drawing it.
 *
 * Structure questions *are* graded automatically: the key and each submitted structure
 * are both run through Indigo to InChI and compared, so this is a real answer key and not
 * a note to the grader. This lived only in the assignment page's `GradingControls` until
 * the session page needed the same thing — hence a shared component rather than a second
 * copy of the Ketcher wiring.
 *
 * The editor opens in a modal. Inline it was a 500px canvas wedged into whatever card
 * happened to contain it, and the overlay is portalled to `document.body` because this
 * field sits several cards deep, where a `fixed` position cannot be trusted.
 */
export default function StructureKeyField({ value, onSave, pending, disabled }: Props) {
  const [editing, setEditing] = useState(false)
  const ketcherRef = useRef<Ketcher | null>(null)
  const initialStruct = useRef('')

  // Escape closes, matching every other modal here. It discards, which is exactly what
  // Cancel does — there is no draft to lose that Cancel would have kept.
  useEffect(() => {
    if (!editing) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setEditing(false)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [editing])

  function open(seed: string) {
    initialStruct.current = seed
    setEditing(true)
  }

  return (
    <>
      {!value ? (
        <button
          onClick={() => open('')}
          disabled={disabled}
          className="text-xs text-signal hover:text-signal border border-signal/20 px-2.5 py-1.5 rounded-sm disabled:opacity-50"
        >
          Set correct structure…
        </button>
      ) : (
        <div className="flex items-center gap-3">
          <StructureRenderer inchi={value} width={180} height={120} />
          <div className="flex flex-col gap-1.5">
            <button
              onClick={() => open(value)}
              disabled={disabled}
              className="text-xs text-signal hover:text-signal border border-signal/20 px-2.5 py-1 rounded-sm disabled:opacity-50"
            >
              Change
            </button>
            <button
              onClick={() => onSave(null)}
              disabled={pending || disabled}
              className="text-xs text-muted hover:text-red-600 border border-hairline px-2.5 py-1 rounded-sm disabled:opacity-50"
            >
              Clear
            </button>
          </div>
        </div>
      )}

      {editing && createPortal(
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <Card flat className="w-full max-w-4xl p-5 shadow-pop flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-ink">Correct structure</h2>
              <button
                onClick={() => setEditing(false)}
                aria-label="Close without saving"
                className="text-muted hover:text-ink-2 transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <p className="text-xs text-muted leading-snug">
              Draw the structure a correct answer should match. Submitted structures are
              compared to it by InChI, so any equivalent drawing counts.
            </p>

            <div className="h-[60vh] min-h-[360px] border border-hairline rounded-[14px] overflow-hidden">
              <Editor
                staticResourcesUrl=""
                structServiceProvider={structServiceProvider}
                errorHandler={(err) => console.error('Ketcher error:', err)}
                onInit={async (ketcher) => {
                  ketcherRef.current = ketcher
                  if (initialStruct.current) {
                    await ketcher.setMolecule(initialStruct.current)
                  }
                }}
              />
            </div>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setEditing(false)}
                className="px-4 py-2 text-sm text-muted hover:text-ink transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={async () => {
                  const molfile = ketcherRef.current ? await ketcherRef.current.getMolfile() : ''
                  onSave(molfile || null)
                  setEditing(false)
                }}
                disabled={pending}
                className="inline-flex items-center justify-center gap-1.5 rounded-sm px-4 py-2 text-sm font-bold bg-signal text-white hover:bg-[var(--signal-bright)] transition-colors disabled:opacity-50"
              >
                {pending ? 'Saving…' : 'Save structure'}
              </button>
            </div>
          </Card>
        </div>,
        document.body,
      )}
    </>
  )
}
