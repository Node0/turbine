/**
 * shared/engine/validators.ts — pluggable output checks.
 *
 *   none          accept anything
 *   conserve      the output must still read as the input text, both with
 *                 Markdown syntax stripped (word-sequence similarity ≥ threshold). This is
 *                 the guard for formatting passes over an embeddings corpus:
 *                 you want Darwin's words, not the formatting model's.
 *   length-ratio  output length / focus length must fall inside [min, max]
 */

import { lcs } from 'fast-myers-diff'
import type { ValidationResult, ValidatorSpec } from '../types.ts'

/**
 * Markdown cleanup for comparison, as an ordered table: each rule has a name
 * and a reason, and runs after the ones above it. No rule crosses a line
 * break, so a rule that misfires costs one line at most.
 *
 * The table only removes LETTERS a reader never sees as prose (tag names,
 * URLs, fence languages, entity names). Punctuation markup (** _ # > | - 1.)
 * needs no rule: normalizeForCompare turns every non-letter into a space on
 * both sides anyway.
 *
 * Angle brackets are markup only in autolinks, raw HTML and link
 * destinations; inside code they are literal, and anywhere else (1 < 2, ->)
 * they are prose.
 */
interface MarkdownRule {
  name: string
  pattern: RegExp
  replace: string | ((match: string, ...groups: string[]) => string)
  why: string
}

/** HTML elements a model might plausibly emit in Markdown output. Anything else in angle brackets is prose. */
const HTML_ELEMENTS = new Set(
  ('a abbr address article aside b bdi bdo blockquote br caption center cite code col colgroup dd del details dfn div dl dt em figcaption figure font ' +
    'footer h1 h2 h3 h4 h5 h6 header hr i img ins kbd li mark nav ol p pre q rp rt ruby s samp section small span strike strong sub summary sup ' +
    'table tbody td tfoot th thead time tr tt u ul var wbr').split(' '),
)

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

export const MARKDOWN_RULES: readonly MarkdownRule[] = [
  { name: 'fence lines', pattern: /^[ \t]{0,3}(`{3,}|~{3,})[^\n]*$/gm, replace: '', why: 'the fence and its language name ("```python") are not prose; the code inside stays' },
  { name: 'autolinks', pattern: /<((?:https?|ftp|mailto):[^\s<>]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+)>/g, replace: '$1', why: 'the reader sees the address itself, so keep it and drop only the brackets' },
  { name: 'html comments', pattern: /<!--[^\n]*?-->/g, replace: '', why: 'never shown' },
  { name: 'html tags', pattern: /<\/?([A-Za-z][\w-]*)(?:[ \t][^<>\n]*)?\/?>/g, replace: (m, name: string) => (HTML_ELEMENTS.has(name.toLowerCase()) ? '' : m), why: 'only real HTML elements, on one line: x<y and y>x is maths, not a <y> tag' },
  { name: 'images', pattern: /!\[([^\]\n]*)\]\([^)\n]*\)/g, replace: '$1', why: 'keep the alt text, drop the URL' },
  { name: 'links', pattern: /\[([^\]\n]*)\]\((?:<[^>\n]*>|[^)\n]*)\)/g, replace: '$1', why: 'keep the link text, drop the destination (including <url> form)' },
  {
    name: 'entities',
    pattern: /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    replace: (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m)),
    why: 'last, so a written-out &lt;b&gt; reads as the text "<b>", not as a tag to remove',
  },
]

/** Code spans are literal: no rule may touch their contents. They are parked, the rules run, then they come back. */
const CODE_SPAN = /(`+)([^`\n]|[^`\n][^\n]*?[^`\n])\1(?!`)/g
const PARKED = /(\d+)/g

export function stripMarkdown(s: string): string {
  const parked: string[] = []
  const park = (text: string): string => `\uE000${parked.push(text) - 1}\uE001`
  // Lines inside a fenced block are code: park them whole, first, so code spans can't be parked twice.
  let inFence = false
  let out = s
    .split('\n')
    .map((line) => {
      if (/^[ \t]{0,3}(`{3,}|~{3,})/.test(line)) {
        inFence = !inFence
        return line
      }
      return inFence ? park(line) : line
    })
    .join('\n')
  out = out.replace(CODE_SPAN, (_m, _ticks: string, body: string) => park(body))
  for (const rule of MARKDOWN_RULES) out = out.replace(rule.pattern, rule.replace as never)
  return out.replace(PARKED, (_m, i: string) => parked[Number(i)])
}

const QUOTES: Record<string, string> = { '“': '"', '”': '"', '‘': "'", '’': "'", '—': '-', '–': '-', '…': '...' }

/** Lowercase, unify quotes/dashes, drop everything but letters, digits and spaces. */
export function normalizeForCompare(s: string): string {
  return s
    .replace(/[“”‘’—–…]/g, (c) => QUOTES[c] ?? c)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 2·LCS / (|a| + |b|) over word arrays — order-sensitive, insertion/deletion
 * tolerant. Myers' O((N+M)·D) diff: near-linear when the output is close to the
 * focus (the normal case), quadratic only for unrelated text. The cap bounds
 * that worst case so a pathological window can't hang a worker.
 */
export function sequenceSimilarity(a: string[], b: string[], cap = 12_000): number {
  if (a.length === 0 && b.length === 0) return 1
  if (a.length === 0 || b.length === 0) return 0
  const x = a.length > cap ? a.slice(0, cap) : a
  const y = b.length > cap ? b.slice(0, cap) : b
  let common = 0
  for (const [, , len] of lcs(x, y)) common += len
  return (2 * common) / (x.length + y.length)
}

export function conserveScore(focus: string, output: string): number {
  // Both sides go through the same steps, so a faithful copy scores 1 by construction.
  const a = normalizeForCompare(stripMarkdown(focus)).split(' ').filter(Boolean)
  const b = normalizeForCompare(stripMarkdown(output)).split(' ').filter(Boolean)
  return sequenceSimilarity(a, b)
}

export function validateWindow(spec: ValidatorSpec, focus: string, output: string): ValidationResult {
  switch (spec.kind) {
    case 'none':
      return { ok: true, kind: 'none' }
    case 'conserve': {
      const threshold = spec.threshold ?? 0.95
      const score = conserveScore(focus, output)
      const ok = score >= threshold
      return { ok, kind: 'conserve', score: round(score), reason: ok ? undefined : `text similarity ${round(score)} < ${threshold}` }
    }
    case 'length-ratio': {
      const min = spec.minRatio ?? 0.5
      const max = spec.maxRatio ?? 2.0
      const ratio = focus.length === 0 ? 1 : output.length / focus.length
      const ok = ratio >= min && ratio <= max
      return { ok, kind: 'length-ratio', score: round(ratio), reason: ok ? undefined : `length ratio ${round(ratio)} outside [${min}, ${max}]` }
    }
    default:
      return { ok: true, kind: 'none', reason: `unknown validator '${String((spec as { kind: unknown }).kind)}' treated as none` }
  }
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}
