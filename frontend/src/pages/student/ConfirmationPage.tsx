import { Link } from 'react-router-dom'
import StudentLayout from '@/components/layout/StudentLayout'
import { CheckCircle } from 'lucide-react'

export default function ConfirmationPage() {
  return (
    <StudentLayout>
      <div className="bg-surface rounded-[14px] shadow-card border border-hairline p-10 text-center">
        <CheckCircle className="mx-auto text-good mb-4" size={48} />
        <h1 className="text-2xl font-bold text-ink mb-2">Response submitted</h1>
        <p className="text-muted text-sm">Your response has been recorded. You're all set.</p>
        <Link
          to="/student"
          className="inline-block mt-8 text-sm text-signal hover:underline"
        >
          Back to my classes
        </Link>
      </div>
    </StudentLayout>
  )
}
