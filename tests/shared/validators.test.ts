import { describe, expect, it } from 'bun:test'
import { conserveScore, normalizeForCompare, sequenceSimilarity, stripMarkdown, validateWindow } from '../../shared/engine/validators.ts'

describe('stripMarkdown / normalizeForCompare', () => {
  it('removes formatting but keeps words', () => {
    const md = '## Chapter I\n\nIt was the **best** of _times_, [link](http://x)\n\n- a\n- b\n\n| c | d |\n|---|---|\n| 1 | 2 |'
    expect(normalizeForCompare(stripMarkdown(md))).toBe('chapter i it was the best of times link a b c d 1 2')
  })
  it('unifies curly quotes and dashes', () => {
    expect(normalizeForCompare('“Hello” — it’s')).toBe(normalizeForCompare('"Hello" - it\'s'))
  })
})

describe('stripMarkdown rule table', () => {
  const words = (s: string): string => normalizeForCompare(stripMarkdown(s))
  it('keeps bare angle brackets as prose, even when a > follows lines later', () => {
    expect(stripMarkdown('ratio 1 < 2\nnew paragraph 5 > 4')).toBe('ratio 1 < 2\nnew paragraph 5 > 4')
    expect(stripMarkdown('a <- b -> c, x<y and y>x')).toBe('a <- b -> c, x<y and y>x')
  })
  it('keeps the address of an autolink and drops only its brackets', () => {
    expect(stripMarkdown('see <https://example.org/a?b=1> or <darwin@down.house>')).toBe('see https://example.org/a?b=1 or darwin@down.house')
  })
  it('removes real HTML tags and comments, on one line only', () => {
    expect(stripMarkdown('a<br>b <span class="x">c</span> <!-- note --> d<sup>1</sup>')).toBe('ab c  d1')
    expect(stripMarkdown('<span\nclass="x">')).toBe('<span\nclass="x">')
  })
  it('treats code as literal: spans and fenced blocks keep their brackets and underscores', () => {
    expect(stripMarkdown('use `<div class="a_b">` and `a_b_c` here')).toBe('use <div class="a_b"> and a_b_c here')
    expect(stripMarkdown('```html\n<p>x</p>\n`y`\n```\nafter <b>z</b>')).toBe('\n<p>x</p>\n`y`\n\nafter z')
  })
  it('keeps link and image text, drops destinations (including the <url> form)', () => {
    expect(stripMarkdown('[the text](<a b.html>) and ![a cat](cat.png "t") and [plain](http://x)')).toBe('the text and a cat and plain')
  })
  it('decodes entities last, so a written-out tag stays text', () => {
    expect(stripMarkdown('&lt;b&gt; &amp; &#233;&#x41; &bogus;')).toBe('<b> & éA &bogus;')
  })
  it('leaves words in snake_case names and footnote markers alone', () => {
    expect(words('the snake_case_name and note[^1]')).toBe('the snake case name and note 1')
  })
})

describe('conserve treats both sides the same', () => {
  const prose = 'Where x < 5 holds, the rule -> applies.\n\n' + 'Then the matter rested for a time. '.repeat(40) + '\n\nUntil y > 3, said <darwin@down.house>, and set snake_case_name with `a_b_c`.'
  it('scores a verbatim copy 1, whatever brackets and underscores it contains', () => {
    expect(conserveScore(prose, prose)).toBe(1)
  })
  it('scores 1 when the model only adds markup around the same words', () => {
    const src = 'See http://example.org for the 1 < 2 case.'
    expect(conserveScore(src, 'See <http://example.org> for the `1 < 2` case.')).toBe(1)
    expect(conserveScore('CHAPTER I', '## CHAPTER I')).toBe(1)
  })
  it('still catches a real omission', () => {
    const cut = prose.replace('Then the matter rested for a time. '.repeat(40), 'Then the matter rested. ')
    expect(validateWindow({ kind: 'conserve' }, prose, cut).ok).toBe(false)
  })
})

describe('sequenceSimilarity', () => {
  it('is 1 for identical, 0 for disjoint, symmetric otherwise', () => {
    expect(sequenceSimilarity(['a', 'b'], ['a', 'b'])).toBe(1)
    expect(sequenceSimilarity(['a'], ['b'])).toBe(0)
    const s1 = sequenceSimilarity('the quick brown fox'.split(' '), 'the brown fox'.split(' '))
    const s2 = sequenceSimilarity('the brown fox'.split(' '), 'the quick brown fox'.split(' '))
    expect(s1).toBeCloseTo(s2)
    expect(s1).toBeCloseTo(6 / 7)
  })
})

describe('validateWindow', () => {
  const focus = 'CHAPTER IV.\n\nIt was the best of times, it was the worst of\ntimes, it was the age of wisdom.'
  it('conserve accepts formatting-only changes', () => {
    const out = '## Chapter IV.\n\nIt was the best of times, it was the worst of times, it was the age of _wisdom_.'
    const r = validateWindow({ kind: 'conserve' }, focus, out)
    expect(r.ok).toBe(true)
    expect(r.score).toBe(1)
  })
  it('conserve rejects paraphrase and truncation', () => {
    expect(validateWindow({ kind: 'conserve' }, focus, 'Times were both great and terrible, and wise.').ok).toBe(false)
    expect(validateWindow({ kind: 'conserve' }, focus, 'CHAPTER IV. It was the best of times.').ok).toBe(false)
    expect(conserveScore(focus, '')).toBe(0)
  })
  it('length-ratio bounds', () => {
    expect(validateWindow({ kind: 'length-ratio' }, 'abcd', 'abcdef').ok).toBe(true)
    expect(validateWindow({ kind: 'length-ratio', maxRatio: 1.2 }, 'abcd', 'abcdefghij').ok).toBe(false)
    expect(validateWindow({ kind: 'length-ratio' }, 'abcdefgh', 'a').ok).toBe(false)
  })
  it('none accepts anything', () => {
    expect(validateWindow({ kind: 'none' }, 'x', '').ok).toBe(true)
  })
})
