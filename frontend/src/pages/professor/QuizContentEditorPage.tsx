import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, CircleAlert, Download } from 'lucide-react'
import { api } from '@/api/client'
import ProfessorLayout from '@/components/layout/ProfessorLayout'
import Button from '@/components/ui/Button'
import Card from '@/components/ui/Card'
import { apiError } from '@/lib/errors'
import { KIND_LABEL, saveText, type QuizContentDetail } from '@/lib/quizGrader'
import QuizPage from './QuizPage'

/**
 * /professor/quiz-grader/:id. A quiz (an assessment) opens its quiz page, where its
 * answer key and boxes are edited too. An answer key or layout file on its own is shown
 * as its YAML: it is edited from the quiz that uses it.
 */
export default function QuizContentEditorPage() {
  const { id } = useParams<{ id: string }>()
  const { data: item, isLoading, error } = useQuery<QuizContentDetail>({
    queryKey: ['quiz-grader', 'content', id],
    queryFn: () => api.get(`/quiz-grader/content/${id}`).then((r) => r.data.data),
  })
  if (item?.kind === 'ASSESSMENT') return <QuizPage id={item.id} />
  return (
    <ProfessorLayout>
      <Link to="/professor/quiz-grader" className="inline-flex items-center gap-1 text-sm text-muted hover:text-ink mb-4">
        <ArrowLeft size={14} /> Paper quizzes
      </Link>
      {isLoading ? null : error || !item ? (
        <p className="text-sm text-warn">{apiError(error, 'Could not open this file')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3 mb-5">
            <div>
              <p className="text-xs font-bold uppercase tracking-widest text-muted">{KIND_LABEL[item.kind]} file</p>
              <h1 className="text-2xl font-bold text-ink">{item.title}</h1>
              <p className="text-xs font-mono text-muted">{item.slug}.yaml</p>
            </div>
            <Button size="sm" onClick={() => saveText(`${item.slug}.yaml`, item.source)}><Download size={13} />Download YAML</Button>
          </div>
          <p className="text-sm text-muted mb-4">Edit this from the quiz that uses it: open the quiz from Paper quizzes and use its Answer key or Boxes tab.</p>
          {(item.issues.length > 0 || item.warnings.length > 0) && (
            <Card flat className="p-4 mb-5 space-y-1">
              {item.issues.map((i) => <p key={i} className="text-sm text-warn flex gap-1.5"><CircleAlert size={15} className="shrink-0 mt-0.5" />{i}</p>)}
              {item.warnings.map((w) => <p key={w} className="text-sm text-muted flex gap-1.5"><AlertTriangle size={15} className="shrink-0 mt-0.5" />{w}</p>)}
              {item.issues.length > 0 && <p className="text-xs text-muted pt-1">Fix these in the YAML and import it again with “replace”.</p>}
            </Card>
          )}
          <Card className="p-4 overflow-x-auto">
            <pre className="text-xs font-mono text-ink-2 whitespace-pre">{item.source}</pre>
          </Card>
        </>
      )}
    </ProfessorLayout>
  )
}
