/**
 * shared/engine/runner.ts — the pump.
 *
 * runJob() is an async generator of WindowEvents. It knows nothing about HTTP,
 * WebSockets, files or the DOM; the server wraps it in a job manager and the
 * browser can drive it directly against the user's own local backend.
 *
 *   map   windows run in parallel (bounded by spec.concurrency); results land by index
 *   fold  windows run in order; each prompt may carry the tail of the previous OUTPUT
 *
 * Per window: generate → validate → (retry at lower temperature)* → record.
 * Validation failures after the last attempt are recorded as 'flagged' with
 * the last output kept. Non-retryable provider errors are 'failed'. An auth
 * failure halts the whole job — every other window would fail the same way.
 */

import { ProviderError } from '../types.ts'
import type {
  ChatMessage, JobSpec, JobStats, Provider, WindowEvent, WindowPlan, WindowRecord,
} from '../types.ts'
import { assembleOutput } from './assemble.ts'
import { sha256Hex } from './hash.ts'
import { estimatePlan, planWindows } from './planner.ts'
import { renderTemplate, scaffoldOf, scrubOutput, type Scaffold } from './template.ts'
import { validateWindow } from './validators.ts'

export interface RunControl {
  signal?: AbortSignal
  /** A reason string while paused, null otherwise. Consulted before each window starts. */
  pauseReason?: () => string | null
  /** Resolves when the job may proceed. Must resolve promptly when not paused. */
  waitUntilResumed?: () => Promise<void>
  /** Resume support: records already on disk. Not re-run; counted in progress. */
  completed?: Iterable<[number, WindowRecord]>
  /** Rerun only these indexes (their previous records are discarded). */
  only?: number[]
  /** Use a stored plan instead of recomputing (the server persists the plan with the job). */
  plan?: WindowPlan[]
  /** Minimum delay between retries, ms. Default 750. */
  retryBaseDelayMs?: number
}

/** Small async queue so concurrent workers can feed one generator. */
class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: Array<() => void> = []
  private closed = false
  push(item: T): void {
    if (this.closed) return
    this.items.push(item)
    this.waiters.shift()?.()
  }
  close(): void {
    this.closed = true
    while (this.waiters.length) this.waiters.shift()?.()
  }
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.items.length) yield this.items.shift() as T
      else if (this.closed) return
      else await new Promise<void>((r) => this.waiters.push(r))
    }
  }
}

export interface WindowVars {
  carry: string
  count: number
}

/** Render the messages for one window. Preview and the real run share this, so they can never disagree. */
export function buildMessages(text: string, spec: JobSpec, w: WindowPlan, vars: WindowVars): ChatMessage[] {
  const user = renderTemplate(spec.userTemplate, {
    context_before: text.slice(w.ctxStart, w.focusStart).trim(),
    focus: text.slice(w.focusStart, w.focusEnd).trim(),
    context_after: text.slice(w.focusEnd, w.ctxEnd).trim(),
    carry: vars.carry,
    window_index: w.index + 1,
    window_count: vars.count,
    source_name: spec.sourceName,
  })
  const system = spec.systemPrompt.trim()
  return system ? [{ role: 'system', content: system }, { role: 'user', content: user }] : [{ role: 'user', content: user }]
}

export function carryFrom(previousOutput: string | undefined, spec: JobSpec): string {
  if (spec.mode !== 'fold' || spec.carry.kind !== 'tail' || !previousOutput) return ''
  return previousOutput.slice(-Math.max(0, spec.carry.chars)).trimStart()
}

export interface CleanedOutput {
  text: string
  /** What was removed (a fence, echoed scaffolding); empty when the output was clean. */
  removed: string[]
}

/** The scaffolding a spec's prompts put around the document; compute once per job, not per window. */
export function specScaffold(spec: Pick<JobSpec, 'userTemplate' | 'systemPrompt'>): Scaffold {
  return scaffoldOf(spec.userTemplate, spec.systemPrompt)
}

/**
 * Make a model's reply into window output: strip a whole-output code fence,
 * then every echo of Turbine's own scaffolding (template.ts scrubOutput), so
 * none of it is stored, carried into the next window, or validated.
 */
export function cleanOutput(raw: string, scaffold: Scaffold): CleanedOutput {
  let s = raw.trim()
  const fence = s.match(/^```[\w-]*\n([\s\S]*?)\n```$/)
  if (fence) s = fence[1].trim()
  const scrubbed = scrubOutput(s, scaffold)
  return { text: scrubbed.text.trim(), removed: fence ? ['whole-output code fence', ...scrubbed.removed] : scrubbed.removed }
}

export function computeStats(records: ReadonlyMap<number, WindowRecord>, total: number, elapsedMs: number): JobStats {
  let flagged = 0
  let failed = 0
  let promptTokens = 0
  let completionTokens = 0
  for (const r of records.values()) {
    if (r.status === 'flagged') flagged++
    if (r.status === 'failed') failed++
    promptTokens += r.usage?.prompt_tokens ?? 0
    completionTokens += r.usage?.completion_tokens ?? 0
  }
  return { done: records.size, flagged, failed, total, elapsed_ms: Math.round(elapsedMs), prompt_tokens: promptTokens, completion_tokens: completionTokens }
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve() }, { once: true })
  })

export async function* runJob(text: string, spec: JobSpec, provider: Provider, control: RunControl = {}): AsyncGenerator<WindowEvent> {
  const windows = control.plan ?? planWindows(text, spec.window, spec.range)
  const estimate = estimatePlan(windows, spec, provider.spec.ctx_len)
  yield { type: 'planned', windows, estimate }

  const total = windows.length
  const records = new Map<number, WindowRecord>(control.completed ?? [])
  if (control.only) for (const i of control.only) records.delete(i)
  const todo = windows.map((w) => w.index).filter((i) => (control.only ? control.only.includes(i) : !records.has(i)))
  const queue = new EventQueue<WindowEvent>()
  const scaffold = specScaffold(spec)
  const signal = control.signal
  const startedAt = Date.now()
  const doneAtStart = records.size
  const state: { halted: { reason: 'auth' | 'error'; error: string } | null } = { halted: null }
  let pausedEmitted = false
  const internalAbort = new AbortController()
  const abortSignal = signal ? AbortSignal.any([signal, internalAbort.signal]) : internalAbort.signal

  const stopping = (): boolean => abortSignal.aborted || state.halted !== null

  const gate = async (): Promise<void> => {
    const reason = control.pauseReason?.()
    if (!reason) return
    if (!pausedEmitted) {
      pausedEmitted = true
      queue.push({ type: 'paused', reason })
    }
    await control.waitUntilResumed?.()
    if (pausedEmitted && !control.pauseReason?.()) {
      pausedEmitted = false
      queue.push({ type: 'resumed' })
    }
  }

  const progress = (): void => {
    const stats = computeStats(records, total, Date.now() - startedAt)
    const completedThisRun = stats.done - doneAtStart
    const remaining = total - stats.done
    const eta = completedThisRun > 0 ? Math.round((stats.elapsed_ms / completedThisRun) * remaining) : null
    queue.push({ type: 'progress', stats, eta_ms: eta })
  }

  const processWindow = async (index: number): Promise<void> => {
    const w = windows[index]
    const focusText = text.slice(w.focusStart, w.focusEnd).trim()
    const carry = carryFrom(records.get(index - 1)?.output, spec)
    const messages = buildMessages(text, spec, w, { carry, count: total })
    const promptHash = await sha256Hex(JSON.stringify({ messages, generation: spec.generation, model: provider.spec.model }))
    const maxAttempts = Math.max(1, spec.retry.maxAttempts)
    let temperature = spec.generation.temperature
    let lastOutput = ''
    let lastValidation = validateWindow({ kind: 'none' }, '', '')
    let lastError: string | undefined
    let lastUsage: WindowRecord['usage']
    let lastModel = provider.spec.model
    let lastScrubbed: string[] = []
    let elapsed = 0
    const startedIso = new Date().toISOString()

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (stopping()) return
      queue.push({ type: 'window-start', index, attempt })
      try {
        const result = await provider.generate(messages, {
          temperature,
          max_tokens: spec.generation.max_tokens,
          num_ctx: spec.generation.num_ctx,
          reasoning: spec.generation.reasoning ?? 'off',
          params: spec.generation.params,
          signal: abortSignal,
          onToken: (chunk) => queue.push({ type: 'window-token', index, chunk }),
        })
        elapsed += result.elapsed_ms
        lastUsage = result.usage
        lastModel = result.model
        const cleaned = cleanOutput(result.text, scaffold)
        const output = cleaned.text
        lastScrubbed = cleaned.removed
        const validation = validateWindow(spec.validator, focusText, output)
        lastOutput = output
        lastValidation = validation
        if (validation.ok) {
          const record: WindowRecord = {
            index, status: 'ok', output, attempt, model: result.model, connection: provider.spec.name, prompt_hash: promptHash,
            started_at: startedIso, elapsed_ms: elapsed, usage: result.usage, validation,
            ...(cleaned.removed.length ? { scrubbed: cleaned.removed } : {}),
          }
          records.set(index, record)
          queue.push({ type: 'window-done', record })
          progress()
          return
        }
        lastError = `validation failed: ${validation.reason ?? validation.kind}`
        queue.push({ type: 'window-failed', index, attempt, error: lastError, final: attempt === maxAttempts })
        temperature = Math.max(0, temperature * spec.retry.temperatureDecay)
      } catch (e) {
        if (abortSignal.aborted) return
        const pe = e instanceof ProviderError ? e : null
        lastError = e instanceof Error ? e.message : String(e)
        const terminal = pe ? !pe.retryable : false
        queue.push({ type: 'window-failed', index, attempt, error: lastError, final: terminal || attempt === maxAttempts })
        if (pe?.isAuth) {
          state.halted = { reason: 'auth', error: lastError }
          internalAbort.abort()
          return
        }
        if (terminal) break
        await sleep((control.retryBaseDelayMs ?? 750) * attempt, abortSignal)
      }
    }
    if (stopping()) return
    const record: WindowRecord = {
      index,
      status: lastOutput ? 'flagged' : 'failed',
      output: lastOutput,
      attempt: maxAttempts,
      model: lastModel,
      connection: provider.spec.name,
      prompt_hash: promptHash,
      started_at: startedIso,
      elapsed_ms: elapsed,
      usage: lastUsage,
      validation: lastValidation,
      error: lastError,
      ...(lastScrubbed.length ? { scrubbed: lastScrubbed } : {}),
    }
    records.set(index, record)
    queue.push({ type: 'window-done', record })
    progress()
  }

  const runAll = async (): Promise<void> => {
    if (spec.mode === 'fold') {
      for (const i of todo) {
        if (stopping()) break
        await gate()
        if (stopping()) break
        await processWindow(i)
      }
      return
    }
    let cursor = 0
    const worker = async (): Promise<void> => {
      while (!stopping()) {
        await gate()
        if (stopping()) return
        const i = todo[cursor++]
        if (i === undefined) return
        await processWindow(i)
      }
    }
    const n = Math.max(1, Math.min(spec.concurrency, todo.length || 1))
    await Promise.all(Array.from({ length: n }, () => worker()))
  }

  const finished = runAll()
    .catch((e: unknown) => {
      state.halted = { reason: 'error', error: e instanceof Error ? e.message : String(e) }
    })
    .finally(() => queue.close())

  for await (const ev of queue) yield ev
  await finished

  const stats = computeStats(records, total, Date.now() - startedAt)
  if (state.halted) {
    yield { type: 'halted', reason: state.halted.reason, error: state.halted.error }
    return
  }
  if (abortSignal.aborted) {
    yield { type: 'cancelled', stats }
    return
  }
  yield { type: 'complete', output: assembleOutput(records, windows, { joiner: spec.joiner, text, markPending: false }), stats }
}
