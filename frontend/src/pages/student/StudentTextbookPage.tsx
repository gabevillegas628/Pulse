import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { api } from '@/api/client'
import TextbookLayout from '@/components/layout/TextbookLayout'
import TextbookPage from '@/pages/shared/TextbookPage'
import { BookOpen } from 'lucide-react'

interface ClassTextbookInfo {
  id: string
  name: string
  textbookRepo: string | null
  textbookPath: string | null
  textbookBranch: string | null
}

export default function StudentTextbookPage() {
  const { classId } = useParams<{ classId: string }>()

  const { data, isLoading, isError } = useQuery<ClassTextbookInfo>({
    queryKey: ['student-class-textbook', classId],
    queryFn: () =>
      api.get(`/student/classes/${classId}/textbook`).then((r) => r.data.data.class),
    staleTime: 60_000,
  })

  const backHref = '/student/classes'

  if (isLoading) {
    return (
      <TextbookLayout backHref={backHref} backLabel="My Classes">
        <div className="flex-1 flex items-center justify-center text-muted text-sm">
          Loading…
        </div>
      </TextbookLayout>
    )
  }

  if (isError || !data) {
    return (
      <TextbookLayout backHref={backHref} backLabel="My Classes">
        <div className="flex-1 flex items-center justify-center text-red-500 text-sm p-8 text-center">
          Could not load class information.
        </div>
      </TextbookLayout>
    )
  }

  if (!data.textbookRepo) {
    return (
      <TextbookLayout backHref={backHref} backLabel="My Classes">
        <div className="flex-1 flex items-center justify-center p-8">
          <div className="text-center">
            <BookOpen size={40} className="mx-auto mb-3 text-muted" />
            <p className="text-sm text-muted">
              No textbook has been linked to <strong className="text-ink-2">{data.name}</strong> yet.
            </p>
          </div>
        </div>
      </TextbookLayout>
    )
  }

  return (
    <TextbookLayout backHref={backHref} backLabel="My Classes">
      <TextbookPage
        repo={data.textbookRepo}
        path={data.textbookPath ?? ''}
        classId={classId}
      />
    </TextbookLayout>
  )
}
