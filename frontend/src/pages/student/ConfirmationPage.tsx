import { Link } from 'react-router-dom'
import StudentLayout from '@/components/layout/StudentLayout'
import { CheckCircle } from 'lucide-react'

export default function ConfirmationPage() {
  return (
    <StudentLayout>
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 p-10 text-center">
        <CheckCircle className="mx-auto text-green-500 mb-4" size={48} />
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Response submitted</h1>
        <p className="text-gray-500 text-sm">Your response has been recorded. You're all set.</p>
        <Link
          to="/student"
          className="inline-block mt-8 text-sm text-primary-600 hover:underline"
        >
          Back to my classes
        </Link>
      </div>
    </StudentLayout>
  )
}
