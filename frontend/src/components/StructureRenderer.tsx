import { useEffect, useState } from 'react'

interface Props {
  inchi: string
  width?: number
  height?: number
}

export default function StructureRenderer({ inchi, width = 260, height = 160 }: Props) {
  const [svg, setSvg] = useState<string | null>(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!inchi) return
    setSvg(null)
    setError(false)
    const token = localStorage.getItem('professor_token') ?? localStorage.getItem('student_token')
    fetch('/api/indigo/indigo/render', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ struct: inchi, output_format: 'image/svg+xml' }),
    })
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((text) => setSvg(text))
      .catch(() => setError(true))
  }, [inchi])

  if (error) {
    return (
      <div style={{ width, height }} className="flex items-center justify-center border border-gray-100 rounded-lg bg-gray-50 text-xs text-gray-400">
        Unable to render
      </div>
    )
  }

  if (!svg) {
    return (
      <div style={{ width, height }} className="flex items-center justify-center border border-gray-100 rounded-lg bg-gray-50 text-xs text-gray-300 animate-pulse">
        Loading…
      </div>
    )
  }

  return (
    <div
      style={{ width, height }}
      className="overflow-hidden [&_svg]:block [&_svg]:w-full [&_svg]:h-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
}
