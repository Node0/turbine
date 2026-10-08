import { describe, expect, it } from 'bun:test'
import { normalizeForCompare } from '../../shared/engine/validators.ts'
import { stripMarkdown } from '../../shared/formats/markdown.ts'

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
