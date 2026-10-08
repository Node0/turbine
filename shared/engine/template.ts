/**
 * shared/engine/template.ts — Turbine's prompt template language.
 *
 *   {{ name }}                      the variable's value (unknown names are left as written, so typos show)
 *   {% if name %}                   render the block when `name` is non-empty
 *   {% if not name %}               …when it IS empty
 *   {% else-if [not] name %}        another branch of the same if
 *   {% else %}                      the fallback branch
 *   {% end-if name %}               closes the if; must name the same variable it opened with
 *
 * Empty means undefined, null, '', 0 or false. A tag alone on its line takes
 * the whole line with it, so conditionals don't leave blank lines behind.
 *
 * The source is parsed once into a tree and values are only ever inserted,
 * never parsed again: a document that contains `{{ … }}` or `{% … %}` comes
 * through as plain text. A `{{` that isn't a variable is text; a `{%` that
 * isn't a well-formed tag is an error with a line and column, never silently
 * passed through.
 */

export const TEMPLATE_VARS = [
  'context_before',
  'focus',
  'context_after',
  'carry',
  'window_index',
  'window_count',
  'source_name',
] as const

export type TemplateVar = (typeof TEMPLATE_VARS)[number]
export type TemplateVars = Record<TemplateVar, string | number> & Record<string, string | number>

export class TemplateError extends Error {
  constructor(message: string, readonly line: number, readonly col: number) {
    super(`${message} (line ${line}, column ${col})`)
    this.name = 'TemplateError'
  }
}

interface Condition {
  name: string
  negated: boolean
}

type Node =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string; raw: string }
  | { kind: 'if'; name: string; branches: { cond: Condition; body: Node[] }[]; otherwise: Node[] | null }

export interface Template {
  nodes: Node[]
}

type Token =
  | { kind: 'text'; text: string }
  | { kind: 'var'; name: string; raw: string }
  | { kind: 'tag'; tag: 'if' | 'else-if' | 'else' | 'end-if'; cond: Condition | null; at: number }

const NAME = '[A-Za-z_][\\w.-]*'
const VAR_RE = new RegExp(`^\\{\\{\\s*(${NAME})\\s*\\}\\}`)
const TAG_RE = new RegExp(`^(if|else-if|else|end-if)(?:\\s+(not\\s+)?(${NAME}))?$`)

function position(src: string, at: number): { line: number; col: number } {
  const before = src.slice(0, at)
  const line = before.split('\n').length
  return { line, col: at - before.lastIndexOf('\n') }
}

function fail(src: string, at: number, message: string): never {
  const { line, col } = position(src, at)
  throw new TemplateError(message, line, col)
}

/** A tag with only whitespace around it on its line: return the span of that whole line, newline included. */
function standaloneLine(src: string, start: number, end: number): [number, number] | null {
  let a = start
  while (a > 0 && (src[a - 1] === ' ' || src[a - 1] === '\t')) a--
  if (a > 0 && src[a - 1] !== '\n') return null
  let b = end
  while (b < src.length && (src[b] === ' ' || src[b] === '\t' || src[b] === '\r')) b++
  if (b < src.length && src[b] !== '\n') return null
  return [a, b < src.length ? b + 1 : b]
}

function tokenize(src: string): Token[] {
  const tokens: Token[] = []
  let text = ''
  let i = 0
  const flush = (): void => {
    if (text) tokens.push({ kind: 'text', text })
    text = ''
  }
  while (i < src.length) {
    if (src.startsWith('{{', i)) {
      const m = VAR_RE.exec(src.slice(i))
      if (m) {
        flush()
        tokens.push({ kind: 'var', name: m[1], raw: m[0] })
        i += m[0].length
        continue
      }
    } else if (src.startsWith('{%', i)) {
      const close = src.indexOf('%}', i + 2)
      if (close < 0) fail(src, i, '`{%` is never closed with `%}`')
      const body = src.slice(i + 2, close).trim()
      const m = TAG_RE.exec(body)
      if (!m) fail(src, i, `unknown tag \`{% ${body} %}\`; expected if, else-if, else or end-if`)
      const tag = m[1] as 'if' | 'else-if' | 'else' | 'end-if'
      const name = m[3]
      const negated = Boolean(m[2])
      if (tag === 'else' && name) fail(src, i, '`{% else %}` takes no variable; use `{% else-if name %}`')
      if (tag !== 'else' && !name) fail(src, i, `\`{% ${tag} %}\` needs a variable name`)
      if (tag === 'end-if' && negated) fail(src, i, '`{% end-if %}` takes the bare variable name, without `not`')
      let end = close + 2
      const line = standaloneLine(src, i, end)
      if (line) {
        text = text.slice(0, text.length - (i - line[0]))
        end = line[1]
      }
      flush()
      tokens.push({ kind: 'tag', tag, cond: name ? { name, negated } : null, at: i })
      i = end
      continue
    }
    text += src[i]
    i++
  }
  flush()
  return tokens
}

export function parseTemplate(src: string): Template {
  const tokens = tokenize(src)
  let pos = 0

  // Parse nodes until a tag that ends the current block; return that tag (or null at end of input).
  function block(into: Node[]): Extract<Token, { kind: 'tag' }> | null {
    while (pos < tokens.length) {
      const t = tokens[pos++]
      if (t.kind === 'text') into.push({ kind: 'text', text: t.text })
      else if (t.kind === 'var') into.push({ kind: 'var', name: t.name, raw: t.raw })
      else if (t.tag === 'if') into.push(ifNode(t))
      else return t
    }
    return null
  }

  function ifNode(open: Extract<Token, { kind: 'tag' }>): Node {
    const name = open.cond!.name
    const branches: { cond: Condition; body: Node[] }[] = []
    let otherwise: Node[] | null = null
    let cond: Condition | null = open.cond
    for (;;) {
      const body: Node[] = []
      const end = block(body)
      if (cond) branches.push({ cond, body })
      else otherwise = body
      if (!end) fail(src, open.at, `\`{% if ${name} %}\` is never closed with \`{% end-if ${name} %}\``)
      if (end.tag === 'end-if') {
        if (end.cond!.name !== name) fail(src, end.at, `\`{% end-if ${end.cond!.name} %}\` closes \`{% if ${name} %}\`; expected \`{% end-if ${name} %}\``)
        return { kind: 'if', name, branches, otherwise }
      }
      if (otherwise) fail(src, end.at, `\`{% ${end.tag} %}\` after \`{% else %}\` in \`{% if ${name} %}\``)
      cond = end.tag === 'else-if' ? end.cond : null
    }
  }

  const nodes: Node[] = []
  const stray = block(nodes)
  if (stray) fail(src, stray.at, `\`{% ${stray.tag}${stray.cond ? ` ${stray.cond.name}` : ''} %}\` without a matching \`{% if %}\``)
  return { nodes }
}

function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === '' || v === 0 || v === false
}

function renderNodes(nodes: Node[], scope: Record<string, unknown>, out: string[]): void {
  for (const n of nodes) {
    if (n.kind === 'text') out.push(n.text)
    else if (n.kind === 'var') {
      const v = scope[n.name]
      out.push(v === undefined ? n.raw : String(v))
    } else {
      const hit = n.branches.find((b) => isEmpty(scope[b.cond.name]) === b.cond.negated)
      const body = hit ? hit.body : n.otherwise
      if (body) renderNodes(body, scope, out)
    }
  }
}

/** Render a template (source or parsed) with these variables. Throws TemplateError on a malformed template. */
export function renderTemplate(template: string | Template, vars: Partial<TemplateVars>): string {
  const parsed = typeof template === 'string' ? parseTemplate(template) : template
  const out: string[] = []
  renderNodes(parsed.nodes, vars as Record<string, unknown>, out)
  return out.join('')
}

function collect(nodes: Node[], seen: Set<string>): void {
  for (const n of nodes) {
    if (n.kind === 'var') seen.add(n.name)
    else if (n.kind === 'if') {
      for (const b of n.branches) {
        seen.add(b.cond.name)
        collect(b.body, seen)
      }
      if (n.otherwise) collect(n.otherwise, seen)
    }
  }
}

export interface TemplateCheck {
  /** Every variable the template references, in first-use order. */
  variables: string[]
  /** Names the template uses that Turbine will not supply. */
  unknown: string[]
  /** The first syntax error, or null. When set, `variables` and `unknown` are empty. */
  error: TemplateError | null
}

/** Inspect a template without rendering it, for the editor. Never throws. */
export function checkTemplate(src: string): TemplateCheck {
  try {
    const seen = new Set<string>()
    collect(parseTemplate(src).nodes, seen)
    const known = new Set<string>(TEMPLATE_VARS)
    const variables = [...seen]
    return { variables, unknown: variables.filter((v) => !known.has(v)), error: null }
  } catch (e) {
    if (e instanceof TemplateError) return { variables: [], unknown: [], error: e }
    throw e
  }
}

/**
 * Scaffolding: everything Turbine itself puts around the document in a prompt.
 * It must never reach the output. Derived from the template actually in use
 * (plus the default's vocabulary, so switching templates mid-corpus is safe),
 * never guessed by a model.
 */
export interface Scaffold {
  /** Tags that wrap the focus: an echoed wrapper is removed and its content kept. */
  unwrap: string[]
  /** Tags that wrap read-only material (context, carry): an echoed block is removed with its content. */
  drop: string[]
  /** Instruction lines from the template and system prompt that must never appear in output. */
  lines: string[]
}

const PAIRED_TAG_BEFORE = /<([A-Za-z][\w-]*)>\s*$/
const PAIRED_TAG_AFTER = /^\s*<\/([A-Za-z][\w-]*)>/
/** Instruction lines shorter than this many words could plausibly occur in a book; leave those alone. */
const MIN_INSTRUCTION_WORDS = 4

/** Tags that sit directly around a variable (`<x>{{var}}</x>`), recursing into conditionals. */
function wrappers(nodes: Node[], found: Map<string, string>): void {
  nodes.forEach((n, i) => {
    if (n.kind === 'if') {
      for (const b of n.branches) wrappers(b.body, found)
      if (n.otherwise) wrappers(n.otherwise, found)
      return
    }
    if (n.kind !== 'var') return
    const before = nodes[i - 1]
    const after = nodes[i + 1]
    const open = before?.kind === 'text' ? PAIRED_TAG_BEFORE.exec(before.text)?.[1] : undefined
    const close = after?.kind === 'text' ? PAIRED_TAG_AFTER.exec(after.text)?.[1] : undefined
    if (open && open === close) found.set(open, n.name)
  })
}

/** Lines of the template with no variable or tag on them: pure instruction text. */
function literalLines(src: string, out: Set<string>): void {
  for (const line of src.split('\n')) if (!line.includes('{{') && !line.includes('{%')) out.add(line)
}

function isInstruction(line: string): boolean {
  const t = line.trim()
  return t.split(/\s+/).length >= MIN_INSTRUCTION_WORDS && !/^<\/?[A-Za-z][\w-]*>$/.test(t)
}

/** The scaffolding of a template (and its system prompt). A template that doesn't parse contributes nothing of its own. */
export function scaffoldOf(template: string, systemPrompt = ''): Scaffold {
  const tags = new Map<string, string>()
  const lines = new Set<string>()
  for (const src of new Set([DEFAULT_USER_TEMPLATE, template])) {
    try {
      wrappers(parseTemplate(src).nodes, tags)
      literalLines(src, lines)
    } catch {
      /* a malformed template never runs; the default's vocabulary still applies */
    }
  }
  for (const line of systemPrompt.split('\n')) lines.add(line)
  const unwrap = [...tags].filter(([, v]) => v === 'focus').map(([t]) => t)
  const drop = [...tags].filter(([, v]) => v !== 'focus').map(([t]) => t)
  return { unwrap, drop, lines: [...new Set([...lines].filter(isInstruction).map((l) => l.trim()))] }
}

export interface Scrubbed {
  text: string
  /** What was removed, for the window record and the preview; empty when the output was clean. */
  removed: string[]
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const excerpt = (s: string): string => (s.length > 60 ? `${s.slice(0, 57)}…` : s)

/**
 * Remove Turbine's own scaffolding from a model's output, in this order:
 *   1. echoed read-only blocks (<context_before>…</context_before> etc.), content and all
 *   2. focus wrappers (<focus>, </focus>), keeping what they wrap
 *   3. any leftover lone scaffold tag (a truncated or half-echoed block)
 *   4. whole lines that repeat an instruction line verbatim
 * then collapse the blank lines that leaves behind.
 */
export function scrubOutput(raw: string, scaffold: Scaffold): Scrubbed {
  const removed: string[] = []
  let s = raw
  for (const tag of scaffold.drop) {
    const t = escapeRe(tag)
    s = s.replace(new RegExp(`<${t}>[\\s\\S]*?</${t}>`, 'gi'), (m) => {
      removed.push(`echoed <${tag}> block (${m.length.toLocaleString()} chars)`)
      return ''
    })
  }
  for (const tag of [...scaffold.unwrap, ...scaffold.drop]) {
    const t = escapeRe(tag)
    s = s.replace(new RegExp(`</?${t}>`, 'gi'), (m) => {
      removed.push(`${m} tag`)
      return ''
    })
  }
  if (scaffold.lines.length) {
    const instructions = new Set(scaffold.lines)
    s = s
      .split('\n')
      .filter((line) => {
        const hit = instructions.has(line.trim())
        if (hit) removed.push(`instruction line "${excerpt(line.trim())}"`)
        return !hit
      })
      .join('\n')
  }
  if (removed.length) s = s.replace(/\n{3,}/g, '\n\n').trim()
  return { text: s, removed }
}

const LEGACY = /\{\{\s*([#^/])\s*([\w.-]+)\s*\}\}/g

/**
 * Templates saved before this language used Mustache-style sections:
 * {{#x}} → {% if x %}, {{^x}} → {% if not x %}, {{/x}} → {% end-if x %}.
 * Anything else is returned unchanged.
 */
export function migrateLegacyTemplate(src: string): string {
  return src.replace(LEGACY, (_m, sigil: string, name: string) =>
    sigil === '#' ? `{% if ${name} %}` : sigil === '^' ? `{% if not ${name} %}` : `{% end-if ${name} %}`,
  )
}

export const DEFAULT_SYSTEM_PROMPT = `You are a careful copy editor converting a plain-text book into clean Markdown.

Rules:
- Preserve the author's words exactly. Do not paraphrase, summarize, modernize, or "improve" the prose.
- Turn chapter and section titles into Markdown headings.
- Rejoin lines that were hard-wrapped mid-sentence into single paragraphs.
- Keep verse, tables, and lists structured; use Markdown tables for column-aligned data.
- Keep existing _italics_ and footnote markers.
- Output only the transformed text. No preamble, no commentary, no code fences.`

export const DEFAULT_USER_TEMPLATE = `You are transforming ONE section ("focus") of a longer document: {{source_name}}, window {{window_index}} of {{window_count}}.
The surrounding text is provided only for context. Do not repeat it and do not transform it.
{% if carry %}

The tail of the previous window's OUTPUT, so you can continue consistently:
<previous_output_tail>
{{carry}}
</previous_output_tail>
{% end-if carry %}
{% if context_before %}

<context_before>
{{context_before}}
</context_before>
{% end-if context_before %}

<focus>
{{focus}}
</focus>
{% if context_after %}

<context_after>
{{context_after}}
</context_after>
{% end-if context_after %}

Return only the transformed focus text.`
