interface PulseMarkProps {
  size?: number
  color?: string
}

export default function PulseMark({ size = 22, color = 'var(--signal)' }: PulseMarkProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 13 H7 L9 7 L12 17 L14.5 11 L16 13 H22"
        stroke={color}
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
