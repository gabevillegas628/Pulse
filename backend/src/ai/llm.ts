/**
 * The one place the app talks to a language model, so the provider is a setting.
 *
 *   AI_PROVIDER=claude   (default) Anthropic API, ANTHROPIC_API_KEY
 *   AI_PROVIDER=gemini   Google Gemini. On Vertex AI when GOOGLE_CLOUD_PROJECT is set
 *                        (credentials from GOOGLE_APPLICATION_CREDENTIALS); otherwise the
 *                        Gemini Developer API with GEMINI_API_KEY, which is for mock data
 *                        only: student work goes through the Vertex project the university's
 *                        agreement covers.
 *
 * Every call names a role, not a model. Each role has a default model per provider and an
 * env var that overrides it for whichever provider is active (ROLES below). The models only
 * read and classify; nothing here decides a score.
 */
import Anthropic from '@anthropic-ai/sdk'
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod'
import { ApiError, GoogleGenAI, ThinkingLevel } from '@google/genai'
import * as z from 'zod/v4'
import { config } from '../config/index.js'

export type Provider = 'claude' | 'gemini'
export type Effort = 'low' | 'medium' | 'high'

/**
 * What each call is for, its default model on each provider, and the env var that
 * overrides it. The Claude column is what the app used before providers existed.
 * Gemini: Flash-Lite for quick transcription, Flash for everything else; strong roles get
 * more thinking (Effort), not a preview model.
 */
export const ROLES = {
  'quiz.text':                  { env: 'MODEL_TEXT',                  claude: 'claude-haiku-5-5',  gemini: 'gemini-3.5-flash-lite' },
  'quiz.structure':             { env: 'MODEL_STRUCTURE',             claude: 'claude-sonnet-5-5', gemini: 'gemini-3.8-flash' },
  'quiz.secondLook':            { env: 'MODEL_SECOND_LOOK',           claude: 'claude-sonnet-5-5', gemini: 'gemini-3.8-flash' },
  'quiz.structureSecondLook':   { env: 'MODEL_STRUCTURE_SECOND_LOOK', claude: 'claude-opus-5-5',   gemini: 'gemini-3.8-flash' },
  'quiz.suggest':               { env: 'MODEL_SUGGEST',               claude: 'claude-opus-5-5',   gemini: 'gemini-3.8-flash' },
  'themes.bootstrap':           { env: 'MODEL_THEMES_BOOTSTRAP',      claude: 'claude-opus-5',     gemini: 'gemini-3.8-flash' },
  'themes.classify':            { env: 'MODEL_THEMES_CLASSIFY',       claude: 'claude-haiku-4-5',  gemini: 'gemini-3.5-flash-lite' },
  'responses.grade':            { env: 'MODEL_GRADING',               claude: 'claude-sonnet-4-6', gemini: 'gemini-3.8-flash' },
  'responses.summarize':        { env: 'MODEL_SUMMARIZE',             claude: 'claude-sonnet-4-6', gemini: 'gemini-3.8-flash' },
} as const satisfies Record<string, { env: string; claude: string; gemini: string }>

export type Role = keyof typeof ROLES

export function provider(): Provider {
  const p = (process.env.AI_PROVIDER ?? 'claude').trim().toLowerCase()
  if (p === 'claude' || p === 'anthropic') return 'claude'
  if (p === 'gemini' || p === 'google') return 'gemini'
  throw new Error(`AI_PROVIDER must be "claude" or "gemini", not "${p}"`)
}

/** Whether the active provider has what it needs to make a call. */
export function aiConfigured(): boolean {
  return provider() === 'claude'
    ? Boolean(config.anthropicApiKey)
    : Boolean(process.env.GOOGLE_CLOUD_PROJECT || process.env.GEMINI_API_KEY)
}

/** For messages: which setting turns the AI features on, for the active provider. */
export function aiSetupHint(): string {
  return provider() === 'claude' ? 'ANTHROPIC_API_KEY' : 'GOOGLE_CLOUD_PROJECT (Vertex AI)'
}

export function modelFor(role: Role): string {
  const r = ROLES[role]
  return process.env[r.env] || r[provider()]
}

// ── Clients, made on first use so an unconfigured provider costs nothing ───────

let anthropic: Anthropic | null = null
function claude(): Anthropic {
  return (anthropic ??= new Anthropic({ apiKey: config.anthropicApiKey }))
}

let google: GoogleGenAI | null = null
function gemini(): GoogleGenAI {
  if (google) return google
  const project = process.env.GOOGLE_CLOUD_PROJECT
  google = project
    ? new GoogleGenAI({ vertexai: true, project, location: process.env.GOOGLE_CLOUD_LOCATION || 'global' })
    : new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  return google
}

// ── Calls ──────────────────────────────────────────────────────────────────────

/** One piece of a prompt, in order: text, or a PNG the model looks at. */
export type Part = { type: 'text'; text: string } | { type: 'image'; png: Buffer }

export interface Usage {
  model: string
  input_tokens: number
  /** Includes Gemini's thinking tokens, which are billed as output. */
  output_tokens: number
}

interface CallOptions<S extends z.ZodType> {
  model: string
  parts: Part[]
  schema: S
  maxTokens: number
  /** Claude: output_config.effort. Gemini: thinking level. Omitted: the model's default. */
  effort?: Effort
  temperature?: number
}

/**
 * A reply in the shape of `schema`, or `parsed: null` when the model refused or ran out of
 * tokens. Callers decide whether to retry.
 */
export async function generateStructured<S extends z.ZodType>(
  opts: CallOptions<S>,
): Promise<{ parsed: z.infer<S> | null; usage: Usage; stopReason: string }> {
  return provider() === 'claude' ? claudeStructured(opts) : geminiStructured(opts)
}

/** Free text. For the older callers that ask for JSON in the prompt and parse it themselves. */
export async function generateText(opts: {
  model: string
  prompt: string
  maxTokens: number
  temperature?: number
}): Promise<{ text: string; usage: Usage }> {
  if (provider() === 'claude') {
    const res = await claude().messages.create({
      model: opts.model,
      max_tokens: opts.maxTokens,
      ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
      messages: [{ role: 'user', content: opts.prompt }],
    })
    const text = res.content.find((b) => b.type === 'text')?.text ?? ''
    return { text, usage: { model: opts.model, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens } }
  }
  const res = await gemini().models.generateContent({
    model: opts.model,
    contents: [{ role: 'user', parts: [{ text: opts.prompt }] }],
    config: {
      maxOutputTokens: opts.maxTokens + THINKING_ALLOWANCE.medium,
      ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    },
  })
  return { text: res.text ?? '', usage: geminiUsage(opts.model, res.usageMetadata) }
}

async function claudeStructured<S extends z.ZodType>(opts: CallOptions<S>) {
  const content: Anthropic.ContentBlockParam[] = opts.parts.map((p) =>
    p.type === 'text'
      ? { type: 'text', text: p.text }
      : { type: 'image', source: { type: 'base64', media_type: 'image/png', data: p.png.toString('base64') } },
  )
  const res = await claude().messages.parse({
    model: opts.model,
    max_tokens: opts.maxTokens,
    ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
    output_config: {
      ...(opts.effort ? { effort: opts.effort } : {}),
      format: zodOutputFormat(opts.schema),
    },
    messages: [{ role: 'user', content }],
  })
  return {
    parsed: (res.parsed_output ?? null) as z.infer<S> | null,
    usage: { model: opts.model, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens },
    stopReason: String(res.stop_reason),
  }
}

/**
 * Gemini counts its thinking against maxOutputTokens, where Claude's max_tokens is the
 * answer alone in practice. Room for the thinking is added on top so a long answer is not
 * cut off by the thinking before it.
 */
const THINKING_ALLOWANCE: Record<Effort, number> = { low: 4096, medium: 8192, high: 16384 }
const THINKING_LEVEL: Record<Effort, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
}

/** The JSON Schema Gemini is given: zod's, without the $schema line it does not accept. */
export function geminiSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>
  return rest
}

async function geminiStructured<S extends z.ZodType>(opts: CallOptions<S>) {
  const parts = opts.parts.map((p) =>
    p.type === 'text' ? { text: p.text } : { inlineData: { mimeType: 'image/png', data: p.png.toString('base64') } },
  )
  const res = await gemini().models.generateContent({
    model: opts.model,
    contents: [{ role: 'user', parts }],
    config: {
      maxOutputTokens: opts.maxTokens + THINKING_ALLOWANCE[opts.effort ?? 'medium'],
      ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
      ...(opts.effort ? { thinkingConfig: { thinkingLevel: THINKING_LEVEL[opts.effort] } } : {}),
      responseMimeType: 'application/json',
      responseJsonSchema: geminiSchema(opts.schema),
    },
  })
  const stopReason = String(res.candidates?.[0]?.finishReason ?? 'unknown')
  return { parsed: parseJson(opts.schema, res.text), usage: geminiUsage(opts.model, res.usageMetadata), stopReason }
}

/** The reply checked against the schema; null when it is missing, not JSON, or the wrong shape. */
export function parseJson<S extends z.ZodType>(schema: S, text: string | undefined): z.infer<S> | null {
  if (!text) return null
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return null }
  const r = schema.safeParse(raw)
  return r.success ? r.data : null
}

function geminiUsage(
  model: string,
  m: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number } | undefined,
): Usage {
  return {
    model,
    input_tokens: m?.promptTokenCount ?? 0,
    output_tokens: (m?.candidatesTokenCount ?? 0) + (m?.thoughtsTokenCount ?? 0),
  }
}

/** A rejected key or credentials: retrying will not help, so the caller should give up. */
export function isAuthError(e: unknown): boolean {
  if (e instanceof Anthropic.AuthenticationError) return true
  return e instanceof ApiError && (e.status === 401 || e.status === 403)
}
