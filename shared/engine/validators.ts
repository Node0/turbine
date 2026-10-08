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
import { stripMarkdown } from '../formats/markdown.ts'
import type { ValidationResult, ValidatorSpec } from '../types.ts'

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
