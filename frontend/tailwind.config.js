/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // Pulse design tokens
        canvas:    'var(--canvas)',
        surface:   { DEFAULT: 'var(--surface)', 2: 'var(--surface-2)' },
        ink:       { DEFAULT: 'var(--ink)',      2: 'var(--ink-2)' },
        muted:     'var(--muted)',
        hairline:  { DEFAULT: 'var(--hairline)', strong: 'var(--hairline-strong)' },
        signal:    { DEFAULT: 'var(--signal)',   soft: 'var(--signal-soft)' },
        good:      { DEFAULT: 'var(--good)',     soft: 'var(--good-soft)' },
        warn:      { DEFAULT: 'var(--warn)',     soft: 'var(--warn-soft)' },
      },
      borderRadius: {
        DEFAULT: '14px',
        sm: '9px',
      },
      fontFamily: {
        sans: ['"Hanken Grotesk"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SF Mono', 'monospace'],
      },
      boxShadow: {
        card: 'var(--shadow-card)',
        pop:  'var(--shadow-pop)',
      },
    },
  },
  plugins: [require('@tailwindcss/typography')],
}
