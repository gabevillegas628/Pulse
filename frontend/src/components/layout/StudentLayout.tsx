import { ReactNode } from 'react'

export default function StudentLayout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <main className="flex-1 flex flex-col items-center justify-start px-4 pt-8 pb-16">
        <div className="w-full max-w-md">{children}</div>
      </main>
    </div>
  )
}
