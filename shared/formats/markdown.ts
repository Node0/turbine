/**
 * shared/formats/markdown.ts — what Markdown means to Turbine.
 *
 * Markdown output is one use case among many (book-to-Markdown cleanup is the
 * default preset, not the point of the tool). This module is the home for
 * everything that knows Markdown syntax; today that is the cleanup the conserve
 * validator applies before comparing words.
 */

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
