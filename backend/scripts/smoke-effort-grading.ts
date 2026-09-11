/**
 * Does the effort rubric actually draw the line where the professor wants it?
 *
 * The whole feature is one prompt, so this exercises that prompt against answers
 * whose correct tier is not in question, and asserts the grader agrees. It calls
 * Anthropic for real (a few cents a run, like smoke-themes) and touches no database.
 *
 *   npx tsx scripts/smoke-effort-grading.ts
 *   npx tsx scripts/smoke-effort-grading.ts --understanding   (the other stance too)
 */
import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import { config } from '../src/config/index.js'
import { buildGradingPrompt } from '../src/routes/grading.routes.js'

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey })

const QUESTION = 'Why does an uncoupler like DNP increase oxygen consumption in mitochondria?'
const TOPIC = 'dissipates the proton motive force, so the ETC runs faster'

/** expected: the tier a professor grading on effort would put this in. */
const CASES: { text: string; expected: 'full' | 'partial' | 'none'; why: string }[] = [
  // Real attempts — wrong ones included. These are the whole point of effort grading.
  { text: 'It makes the protons leak back across the membrane so the chain has to keep pumping, which burns more oxygen.', expected: 'full', why: 'correct and reasoned' },
  { text: 'I think DNP damages the mitochondria so they work harder to repair themselves and that uses oxygen.', expected: 'full', why: 'wrong mechanism, genuine attempt' },
  { text: 'because the ATP synthase stops working so the cell panics and burns more fuel', expected: 'full', why: 'confused but engaged' },
  { text: 'it uncouples the gradient from atp production', expected: 'full', why: 'terse but real' },

  // Token effort — the "idk" bucket the professor decided on.
  { text: 'idk', expected: 'partial', why: 'honest non-answer' },
  { text: "I don't know, we didn't cover this", expected: 'partial', why: 'honest non-answer' },
  { text: 'oxygen', expected: 'partial', why: 'bare word, no reasoning' },

  // Not attempts — the gaming case that started this. A bare restatement lands here
  // rather than with "idk": it is a non-answer wearing the shape of one, and unlike
  // "idk" it is not honest about being empty.
  { text: 'Because an uncoupler like DNP increases oxygen consumption in mitochondria.', expected: 'none', why: 'restates the question, adds nothing' },
  { text: 'abcde', expected: 'none', why: 'keysmash' },
  { text: 'asdfasdf', expected: 'none', why: 'keysmash' },
  { text: '.', expected: 'none', why: 'filler' },
  { text: 'The mitochondria is the powerhouse of the cell and produces energy for the body in the form of ATP.', expected: 'none', why: 'fluent, answers a different question' },
]

const TIER: Record<string, 'full' | 'partial' | 'none'> = {
  full_credit: 'full', partial_credit: 'partial', no_credit: 'none',
}

async function main() {
  const mode = process.argv.includes('--understanding') ? 'understanding' as const : 'effort' as const
  const responseList = CASES.map((c, i) => `[${i}] ${c.text}`).join('\n')
  const prompt = buildGradingPrompt(mode, QUESTION, TOPIC, responseList, CASES.length)

  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    temperature: 0,
    messages: [{ role: 'user', content: prompt }],
  })

  const raw = msg.content.find((b) => b.type === 'text')?.text ?? '[]'
  const clean = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
  const parsed = JSON.parse(clean) as { index: number; score: string; reason: string }[]
  const byIndex = new Map(parsed.map((g) => [g.index, g]))

  console.log(`\nmode: ${mode}\n`)
  let pass = 0
  let fail = 0
  for (const [i, c] of CASES.entries()) {
    const g = byIndex.get(i)
    const got = g ? TIER[g.score] ?? '?' : '(missing)'
    // Only the effort rubric has asserted expectations; understanding is for eyeballing.
    const ok = mode === 'understanding' || got === c.expected
    if (ok) pass++; else fail++
    const mark = mode === 'understanding' ? '·' : ok ? 'ok  ' : 'FAIL'
    console.log(`${mark} [${got.padEnd(7)}] want ${c.expected.padEnd(7)} ${JSON.stringify(c.text.slice(0, 58))}`)
    console.log(`      ${c.why} → AI: ${g?.reason ?? '(none)'}`)
  }

  if (mode === 'understanding') {
    console.log('\n(understanding mode is not asserted — read the tiers above)')
    return
  }
  console.log(`\n${pass}/${CASES.length} as expected, ${fail} off`)
  if (fail > 0) process.exitCode = 1
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
