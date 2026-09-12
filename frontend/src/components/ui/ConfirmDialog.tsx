import { useEffect } from 'react'
import { X } from 'lucide-react'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'

export interface DialogRequest {
  title: string
  body?: string
  confirmLabel?: string
  /** Paint the confirm button as a warning. For anything that cannot be undone. */
  destructive?: boolean
  /**
   * What to do when confirmed. Omit it for a notice — something the user only needs to
   * be told, with a single button to dismiss it.
   */
  onConfirm?: () => void
}

interface Props {
  request: DialogRequest | null
  onClose: () => void
}

/**
 * The app's own confirm and notice dialog, replacing `window.confirm` and `alert`.
 *
 * Those were doing five jobs on the session page — deleting a question, re-grading over
 * existing scores, awarding blanket full credit, and reporting two failures — in an
 * OS-styled box that could not carry the app's own emphasis, could not mark a destructive
 * action as destructive, and read as though the page had broken rather than asked.
 */
export default function ConfirmDialog({ request, onClose }: Props) {
  useEffect(() => {
    if (!request) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [request, onClose])

  if (!request) return null

  const isNotice = !request.onConfirm

  return (
    <div
      className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 px-4"
      onClick={onClose}
    >
      <Card
        flat
        className="w-full max-w-sm p-6 shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-3 mb-2">
          <h2 className="text-base font-semibold text-ink">{request.title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-muted hover:text-ink-2 transition-colors shrink-0"
          >
            <X size={18} />
          </button>
        </div>

        {request.body && (
          <p className="text-sm text-muted leading-snug whitespace-pre-line">{request.body}</p>
        )}

        <div className="flex justify-end gap-3 mt-5">
          {!isNotice && (
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-muted hover:text-ink transition-colors"
            >
              Cancel
            </button>
          )}
          <Button
            autoFocus
            variant={request.destructive ? 'ghost' : 'primary'}
            className={request.destructive
              ? 'bg-red-50 text-red-600 border-red-200 hover:bg-red-100'
              : undefined}
            onClick={() => {
              request.onConfirm?.()
              onClose()
            }}
          >
            {request.confirmLabel ?? (isNotice ? 'OK' : 'Confirm')}
          </Button>
        </div>
      </Card>
    </div>
  )
}
