import { useRef, useState } from 'react'
import { Editor } from 'ketcher-react'
import { RemoteStructServiceProvider } from 'ketcher-core'
import type { Ketcher } from 'ketcher-core'
import StructureRenderer from '@/components/StructureRenderer'

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
 */
export default function StructureKeyField({ value, onSave, pending, disabled }: Props) {
  const [editing, setEditing] = useState(false)
  const ketcherRef = useRef<Ketcher | null>(null)
  const initialStruct = useRef('')

  if (editing) {
    return (
      <div className="space-y-2">
        <div className="h-[500px] border border-hairline rounded-[14px] overflow-hidden">
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
        <div className="flex gap-2">
          <button
            onClick={async () => {
              const molfile = ketcherRef.current ? await ketcherRef.current.getMolfile() : ''
              onSave(molfile || null)
              setEditing(false)
            }}
            disabled={pending}
            className="text-xs text-white bg-signal hover:bg-[var(--signal-bright)] px-3 py-1.5 rounded-sm disabled:opacity-50"
          >
            Save
          </button>
          <button onClick={() => setEditing(false)} className="text-xs text-muted px-2 py-1.5">
            Cancel
          </button>
        </div>
      </div>
    )
  }

  if (!value) {
    return (
      <button
        onClick={() => { initialStruct.current = ''; setEditing(true) }}
        disabled={disabled}
        className="text-xs text-signal hover:text-signal border border-signal/20 px-2.5 py-1.5 rounded-sm disabled:opacity-50"
      >
        Set correct structure…
      </button>
    )
  }

  return (
    <div className="flex items-center gap-3">
      <StructureRenderer inchi={value} width={180} height={120} />
      <div className="flex flex-col gap-1.5">
        <button
          onClick={() => { initialStruct.current = value; setEditing(true) }}
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
  )
}
