/**
 * The provider switch (src/ai/llm.ts), offline: fetch is replaced, so nothing leaves the
 * machine and no key is needed. Checks what each provider is sent and how its reply is read.
 *
 *   npx tsx scripts/smoke-ai-provider.ts
 *
 * What this cannot check: that a real Gemini or Claude model reads handwriting as well as
 * the other. That is quiz-grader-spike.ts, run with AI_PROVIDER set, on the same pages.
 */
import * as z from 'zod/v4'

process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
process.env.GEMINI_API_KEY = 'gemini-test'
delete process.env.GOOGLE_CLOUD_PROJECT
for (const v of ['MODEL_TEXT', 'MODEL_STRUCTURE', 'MODEL_GRADING']) delete process.env[v]

const { generateStructured, generateText, geminiSchema, isAuthError, modelFor, aiConfigured } = await import('../src/ai/llm.js')

let passed = 0
let failed = 0
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) { passed++; console.log(`  ✓ ${name}`) } else { failed++; console.log(`  ✗ ${name}`, detail ?? '') }
}

type Seen = { url: string; body: any }
let seen: Seen[] = []
let reply: (url: string) => Response
const realFetch = globalThis.fetch
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
  seen.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
  return reply(url)
}) as typeof fetch

const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } })

const schema = z.object({ slots: z.array(z.object({ slot_id: z.string(), status: z.enum(['blank', 'read']), confidence: z.number() })) })
const png = Buffer.from('fake-png-bytes')
const parts = [
  { type: 'text' as const, text: 'Region r1:' },
  { type: 'image' as const, png },
  { type: 'text' as const, text: 'Transcribe.' },
]
const answer = { slots: [{ slot_id: 's1', status: 'read', confidence: 0.9 }] }

// ── Gemini ─────────────────────────────────────────────────────────────────────
console.log('gemini')
process.env.AI_PROVIDER = 'gemini'

check('roles resolve to Gemini models', modelFor('quiz.text').startsWith('gemini-') && modelFor('responses.grade').startsWith('gemini-'))
process.env.MODEL_TEXT = 'gemini-custom'
check('a role env var overrides the default', modelFor('quiz.text') === 'gemini-custom')
delete process.env.MODEL_TEXT
check('configured by GEMINI_API_KEY (dev) or GOOGLE_CLOUD_PROJECT', aiConfigured())

const js = geminiSchema(schema)
check('schema sent without $schema', !('$schema' in js) && (js as any).type === 'object')

seen = []
reply = () => json({
  candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(answer) }] }, finishReason: 'STOP' }],
  usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 40, thoughtsTokenCount: 300 },
})
const g = await generateStructured({ model: 'gemini-test-model', parts, schema, maxTokens: 8192, effort: 'low' })
const gb = seen[0]?.body
const gparts = gb?.contents?.[0]?.parts ?? []
check('one request, to the model named', seen.length === 1 && seen[0]!.url.includes('gemini-test-model:generateContent'), seen[0]?.url)
check('text and image parts sent in order', gparts.length === 3 && gparts[0].text === 'Region r1:' && gparts[1].inlineData?.mimeType === 'image/png' && gparts[1].inlineData?.data === png.toString('base64') && gparts[2].text === 'Transcribe.', gparts)
check('asks for JSON in the schema', gb?.generationConfig?.responseMimeType === 'application/json' && !!gb?.generationConfig?.responseJsonSchema, gb?.generationConfig)
check('effort becomes a thinking level', gb?.generationConfig?.thinkingConfig?.thinkingLevel === 'LOW', gb?.generationConfig?.thinkingConfig)
check('token limit leaves room for thinking', gb?.generationConfig?.maxOutputTokens > 8192, gb?.generationConfig?.maxOutputTokens)
check('reply parsed against the schema', g.parsed?.slots[0]?.slot_id === 's1')
check('usage counts thinking as output', g.usage.input_tokens === 1200 && g.usage.output_tokens === 340 && g.usage.model === 'gemini-test-model', g.usage)

reply = () => json({ candidates: [{ content: { role: 'model', parts: [{ text: '{"slots":[{"slot_id":1}]}' }] }, finishReason: 'STOP' }] })
const bad = await generateStructured({ model: 'gemini-test-model', parts, schema, maxTokens: 100 })
check('a reply in the wrong shape is null, not trusted', bad.parsed === null)

reply = () => json({ candidates: [{ content: { role: 'model', parts: [{ text: '{"slots":[' }] }, finishReason: 'MAX_TOKENS' }] })
const cut = await generateStructured({ model: 'gemini-test-model', parts, schema, maxTokens: 100 })
check('a truncated reply is null, with the reason', cut.parsed === null && cut.stopReason === 'MAX_TOKENS', cut.stopReason)

seen = []
reply = () => json({ candidates: [{ content: { role: 'model', parts: [{ text: '[{"index":0}]' }] }, finishReason: 'STOP' }] })
const gt = await generateText({ model: 'gemini-test-model', prompt: 'Grade these.', maxTokens: 4096, temperature: 0 })
check('plain text call: prompt and temperature sent, text returned', gt.text === '[{"index":0}]' && seen[0]?.body?.contents?.[0]?.parts?.[0]?.text === 'Grade these.' && seen[0]?.body?.generationConfig?.temperature === 0)

reply = () => json({ error: { code: 403, message: 'denied', status: 'PERMISSION_DENIED' } }, 403)
let authErr: unknown
try { await generateText({ model: 'gemini-test-model', prompt: 'x', maxTokens: 10 }) } catch (e) { authErr = e }
check('403 from Gemini is an auth error (no retries)', isAuthError(authErr), authErr)

// ── Claude ─────────────────────────────────────────────────────────────────────
console.log('claude')
process.env.AI_PROVIDER = 'claude'
check('roles resolve to the Claude models used before', modelFor('quiz.text') === 'claude-haiku-5-5' && modelFor('responses.grade') === 'claude-sonnet-4-6')

seen = []
reply = () => json({
  id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-test',
  content: [{ type: 'text', text: JSON.stringify(answer) }],
  stop_reason: 'end_turn', stop_sequence: null,
  usage: { input_tokens: 900, output_tokens: 50 },
})
const c = await generateStructured({ model: 'claude-test', parts, schema, maxTokens: 8192, effort: 'medium' })
const cb = seen[0]?.body
check('image and text blocks sent in order', cb?.messages?.[0]?.content?.[1]?.type === 'image' && cb?.messages?.[0]?.content?.[1]?.source?.data === png.toString('base64') && cb?.messages?.[0]?.content?.[2]?.text === 'Transcribe.', cb?.messages?.[0]?.content)
check('effort and output format sent', cb?.output_config?.effort === 'medium' && cb?.output_config?.format?.type === 'json_schema', cb?.output_config)
check('no temperature unless asked', !('temperature' in cb))
check('reply parsed', c.parsed?.slots[0]?.status === 'read')
check('usage', c.usage.input_tokens === 900 && c.usage.output_tokens === 50)

reply = () => json({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }, 401)
let claudeAuth: unknown
try { await generateText({ model: 'claude-test', prompt: 'x', maxTokens: 10 }) } catch (e) { claudeAuth = e }
check('401 from Claude is an auth error', isAuthError(claudeAuth), claudeAuth)

process.env.AI_PROVIDER = 'openai'
let threw = false
try { modelFor('quiz.text') } catch { threw = true }
check('an unknown AI_PROVIDER is refused, not defaulted', threw)

globalThis.fetch = realFetch
console.log(`\n  ${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
