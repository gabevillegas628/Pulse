/**
 * Unit tests for the quiz grader's deterministic half: the seed content parses and
 * joins up, and scoring does what the key says. Pure — no model, no database, no
 * images. The model's half is measured by scripts/quiz-grader-spike.ts instead.
 *
 * Usage: npx tsx scripts/smoke-quiz-grader.ts
 */
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  parseAssessment, parseLayout, parsePathwayKey, resolveRef, slotsForVersion,
  type CofactorSpec,
} from '../src/quizGrader/content.js'
import { gradePage } from '../src/quizGrader/grade.js'
import { readTextRegions, type StructureRead, type TextRead } from '../src/quizGrader/reader.js'
import type Anthropic from '@anthropic-ai/sdk'
import { matchText, normalize, scoreCofactors, scoreStructure } from '../src/quizGrader/scoring.js'

let passed = 0
let failed = 0

function check(name: string, ok: boolean) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}`) }
}

const SEED = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'quiz-grader', 'seed')
const read = (p: string) => fs.readFileSync(path.join(SEED, p), 'utf8')

// ── Seed content ───────────────────────────────────────────────────────────────

const gly = parsePathwayKey(read('keys/glycolysis.yaml'))
const tca = parsePathwayKey(read('keys/tca.yaml'))
const glyLayout = parseLayout(read('layouts/glycolysis-template-v1.yaml'))
const tcaLayout = parseLayout(read('layouts/tca-template-v1.yaml'))
const glyQuiz = parseAssessment(read('assessments/glycolysis-quiz.yaml'))
parseAssessment(read('assessments/tca-quiz.yaml'))
check('all seed files parse', true)

// YAML splits unquoted "1,6" inside [...] into two items. This once turned
// "fructose 1,6-bisphosphate" into "fructose 1" and "6-bisphosphate".
check('names with commas survive YAML', gly.intermediates.f16bp!.accept.includes('fructose 1,6-bisphosphate')
  && gly.intermediates.bpg13!.accept.includes('1,3-bisphosphoglycerate')
  && gly.steps['4']!.enzyme.accept.includes('fructose-1,6-bisphosphate aldolase'))

check('every layout ref resolves against its key', (() => {
  try {
    glyLayout.slots.forEach((s) => resolveRef(gly, s.ref))
    tcaLayout.slots.forEach((s) => resolveRef(tca, s.ref))
    return true
  } catch { return false }
})())

for (const v of ['A', 'B', 'C']) {
  const slots = slotsForVersion(glyQuiz, glyLayout, gly, v)
  const structures = slots.filter((s) => s.ref.kind === 'structure').map((s) => (s.ref.kind === 'structure' ? s.ref.id : ''))
  check(`glycolysis ${v}: 10 enzymes, 6 cofactor sets, its 3 starred structures`,
    slots.filter((s) => s.ref.kind === 'enzyme').length === 10
    && slots.filter((s) => s.ref.kind === 'cofactors').length === 6
    && structures.join() === glyQuiz.versions[v]!.structures.slice().sort((a, b) =>
      glyLayout.slots.findIndex((s) => s.ref === `intermediate.${a}`) - glyLayout.slots.findIndex((s) => s.ref === `intermediate.${b}`)).join())
}
check('an unknown version is refused', (() => {
  try { slotsForVersion(glyQuiz, glyLayout, gly, 'Z'); return false } catch { return true }
})())

// ── Normalisation and text matching ────────────────────────────────────────────

check('normalize folds case, spaces, hyphens, commas', normalize('Fructose-1,6-Bisphosphate') === normalize('fructose 1 6 bisphosphate'))
check('normalize folds Greek and subscripts', normalize('α-KG') === 'alphakg' && normalize('H₂O') === 'h2o' && normalize('NAD⁺') === 'nad')

const hk = gly.steps['1']!.enzyme.accept
check('exact alias', matchText('Hexokinase', hk).verdict === 'exact')
check('abbreviation alias', matchText('HK', hk).verdict === 'exact')
check('one-letter misspelling is a fuzzy match', matchText('hexokinose', hk).verdict === 'fuzzy')
check('a different enzyme is wrong', matchText('phosphofructokinase', hk).verdict === 'wrong')
check('blank-ish nonsense is wrong', matchText('kinase', hk).verdict === 'wrong')
const pk = gly.steps['10']!.enzyme.accept
check('short abbreviations are exact-only', matchText('PKK', pk).verdict === 'wrong' && matchText('pk', pk).verdict === 'exact')
check('GAPDH long form with "3-P" fuzzy-matches', matchText('glyceraldehyde 3-P dehydrogenase', gly.steps['6']!.enzyme.accept).verdict !== 'wrong')

// ── Cofactors ──────────────────────────────────────────────────────────────────

const atp: CofactorSpec = gly.steps['1']!.cofactors!
check('both sides right: full credit', scoreCofactors([{ text: 'ATP', side: 'in' }, { text: 'ADP', side: 'out' }], atp).fraction === 1)
check('sides swapped: no credit', scoreCofactors([{ text: 'ADP', side: 'in' }, { text: 'ATP', side: 'out' }], atp).fraction === 0)
{
  const r = scoreCofactors([{ text: 'ATP', side: 'in' }], atp)
  check('one of two groups: half credit, other group missing', r.fraction === 0.5 && r.groups[1]!.status === 'missing')
}
check('optional items are ignored', (() => {
  const r = scoreCofactors([{ text: 'ATP', side: 'in' }, { text: 'Mg2+', side: 'in' }, { text: 'ADP', side: 'out' }], atp)
  return r.fraction === 1 && r.extras.length === 0
})())
check('extra items are listed, not penalised by default', (() => {
  const r = scoreCofactors([{ text: 'ATP', side: 'in' }, { text: 'ADP', side: 'out' }, { text: 'NADH', side: 'out' }], atp)
  return r.fraction === 1 && r.extras.join() === 'NADH'
})())
check('extra-item penalty when configured', scoreCofactors(
  [{ text: 'ATP', side: 'in' }, { text: 'ADP', side: 'out' }, { text: 'NADH', side: 'out' }], atp, { extraPenalty: 0.25 }).fraction === 0.75)
check('enolase: water out, spelled either way', scoreCofactors([{ text: 'water', side: 'out' }], gly.steps['9']!.cofactors!).fraction === 1
  && scoreCofactors([{ text: 'H₂O', side: 'out' }], gly.steps['9']!.cofactors!).fraction === 1)
check('GAPDH accepts NAD and NAD+', scoreCofactors([{ text: 'NAD', side: 'in' }, { text: 'NADH', side: 'out' }], gly.steps['6']!.cofactors!).fraction === 1)
check('an unplaceable item is flagged', scoreCofactors([{ text: 'ATP', side: 'unclear' }], atp).unclearSide)

// ── Structures ─────────────────────────────────────────────────────────────────

check('structure: 3 of 4 features is 0.75', scoreStructure(gly.intermediates.pep!, [true, true, true, false]) === 0.75)
check('structure: weights count', scoreStructure({ name: 'x', accept: [], features: ['a', 'b'], feature_weights: [3, 1] }, [true, false]) === 0.75)

// ── A whole page ───────────────────────────────────────────────────────────────

{
  const slots = slotsForVersion(glyQuiz, glyLayout, gly, 'A')
  const text = new Map<string, TextRead>()
  const t = (slot_id: string, transcription: string, confidence = 0.95, cofactors: TextRead['cofactors'] = []): void => {
    text.set(slot_id, { slot_id, status: 'read', transcription, cofactors, confidence })
  }
  t('s1_enzyme', 'hexokinase')
  t('s1_cofactors', '', 0.95, [{ text: 'ATP', side: 'in' }, { text: 'ADP', side: 'out' }])
  t('s2_enzyme', 'phosphoglucose isomerse', 0.6)
  text.set('s3_enzyme', { slot_id: 's3_enzyme', status: 'illegible', transcription: '', cofactors: [], confidence: 0.2 })
  const struct = new Map<string, StructureRead>([
    ['int_pep', { slot_id: 'int_pep', status: 'read', description: 'PEP', confidence: 0.9,
      features: [0, 1, 2, 3].map((index) => ({ index, present: index < 2, confidence: 0.9 })) }],
  ])
  const results = gradePage(slots, new Set(['s4_enzyme']), text, struct)
  const by = new Map(results.map((r) => [r.slotId, r]))
  check('page: right enzyme scores', by.get('s1_enzyme')!.pointsAuto === 1 && !by.get('s1_enzyme')!.needsReview)
  check('page: cofactors score', by.get('s1_cofactors')!.pointsAuto === 1)
  check('page: low confidence goes to review', by.get('s2_enzyme')!.needsReview)
  check('page: illegible scores 0 and goes to review', by.get('s3_enzyme')!.pointsAuto === 0 && by.get('s3_enzyme')!.needsReview)
  check('page: blank scores 0 without review', by.get('s4_enzyme')!.status === 'blank' && !by.get('s4_enzyme')!.needsReview)
  check('page: structures always reviewed, scored by features', by.get('int_pep')!.pointsAuto === 1 && by.get('int_pep')!.needsReview)
  check('page: a slot the model skipped is an error for review', by.get('s5_enzyme')!.status === 'error' && by.get('s5_enzyme')!.needsReview)
  check('page: names are never read, carry no points, need no review',
    by.get('name')!.status === 'not_sent' && by.get('name')!.maxPoints === 0 && !by.get('name')!.needsReview)
}

// ── Names and NetIDs never reach the model ─────────────────────────────────────

await (async () => {
  const slots = slotsForVersion(glyQuiz, glyLayout, gly, 'A')
  let called = false
  const client = { messages: { parse: async () => { called = true; throw new Error('should not be called') } } } as unknown as Anthropic
  const name = slots.find((g) => g.ref.kind === 'identity')!
  const s1 = slots.find((g) => g.slot.id === 's1_enzyme')!
  let refused = false
  try {
    await readTextRegions(client, gly, [{ id: 'r', png: Buffer.from(''), slots: [s1, name] }])
  } catch (e) {
    refused = e instanceof Error && e.message.includes('names and NetIDs stay local')
  }
  check('the reader refuses a name slot before any API call', refused && !called)
})()

check('an answer box overlapping the name box is refused', (() => {
  const bad = { ...glyLayout, slots: glyLayout.slots.map((s) => (s.id === 's1_enzyme' ? { ...s, box: [0.2, 0.03, 0.3, 0.1] as [number, number, number, number] } : s)) }
  try { slotsForVersion(glyQuiz, bad, gly, 'A'); return false } catch (e) { return e instanceof Error && e.message.includes('overlaps name') }
})())

console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
