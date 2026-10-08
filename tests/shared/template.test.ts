import { describe, expect, it } from 'bun:test'
import { checkTemplate, DEFAULT_USER_TEMPLATE, migrateLegacyTemplate, parseTemplate, renderTemplate, scaffoldOf, scrubOutput, TemplateError } from '../../shared/engine/template.ts'

const errorOf = (src: string): TemplateError => {
  try {
    parseTemplate(src)
  } catch (e) {
    if (e instanceof TemplateError) return e
    throw e
  }
  throw new Error(`expected a TemplateError for ${JSON.stringify(src)}`)
}

describe('renderTemplate: variables', () => {
  it('substitutes variables, tolerating whitespace inside braces', () => {
    expect(renderTemplate('a {{focus}} b {{ window_index }} c', { focus: 'X', window_index: 3 })).toBe('a X b 3 c')
  })
  it('leaves unknown variables intact so the user can see the typo', () => {
    expect(renderTemplate('{{nope}}', { focus: 'x' })).toBe('{{nope}}')
  })
  it('treats a {{ that is not a variable as text', () => {
    expect(renderTemplate('JSON: {{"a": 1}} and {{ }}', {})).toBe('JSON: {{"a": 1}} and {{ }}')
  })
  it('never parses inserted values again, even inside a conditional', () => {
    const doc = 'a < b {{focus}} {% if carry %} {% bogus %}'
    expect(renderTemplate('{% if context_before %}[{{context_before}}]{% end-if context_before %} {{focus}}', { context_before: doc, focus: 'F' })).toBe(`[${doc}] F`)
  })
})

describe('renderTemplate: conditionals', () => {
  const t = '{% if carry %}C:{{carry}}{% else-if focus %}F{% else %}none{% end-if carry %}'
  it('takes the first branch whose condition holds', () => {
    expect(renderTemplate(t, { carry: 'tail', focus: 'x' })).toBe('C:tail')
    expect(renderTemplate(t, { carry: '', focus: 'x' })).toBe('F')
    expect(renderTemplate(t, { carry: '', focus: '' })).toBe('none')
  })
  it('treats undefined, empty string, 0 and false as empty', () => {
    for (const v of [undefined, '', 0, false]) expect(renderTemplate('{% if x %}Y{% else %}N{% end-if x %}', { x: v } as never)).toBe('N')
    expect(renderTemplate('{% if x %}Y{% end-if x %}', { x: ' ' })).toBe('Y')
  })
  it('supports not, in if and else-if', () => {
    const n = '{% if not carry %}first{% else-if not focus %}nofocus{% else %}both{% end-if carry %}'
    expect(renderTemplate(n, { carry: '' })).toBe('first')
    expect(renderTemplate(n, { carry: 'c', focus: '' })).toBe('nofocus')
    expect(renderTemplate(n, { carry: 'c', focus: 'f' })).toBe('both')
  })
  it('nests', () => {
    const n = '{% if focus %}F{% if carry %}+C{% end-if carry %}{% end-if focus %}'
    expect(renderTemplate(n, { focus: 'x', carry: 'y' })).toBe('F+C')
    expect(renderTemplate(n, { focus: 'x', carry: '' })).toBe('F')
    expect(renderTemplate(n, { focus: '', carry: 'y' })).toBe('')
  })
  it('removes the whole line of a tag that stands alone on it', () => {
    const n = 'top\n  {% if carry %}  \nC\n{% end-if carry %}\nbottom'
    expect(renderTemplate(n, { carry: 'y' })).toBe('top\nC\nbottom')
    expect(renderTemplate(n, { carry: '' })).toBe('top\nbottom')
    expect(renderTemplate('a {% if carry %}C{% end-if carry %} b', { carry: '' })).toBe('a  b')
  })
  it('the default template omits empty blocks and leaves no stray blank lines', () => {
    const vars = { context_before: '', focus: 'FOCUS', context_after: '', carry: '', window_index: 1, window_count: 1, source_name: 's' }
    const out = renderTemplate(DEFAULT_USER_TEMPLATE, vars)
    expect(out).toContain('<focus>\nFOCUS\n</focus>')
    expect(out).not.toContain('<context_before>')
    expect(out).not.toContain('previous_output_tail')
    expect(out).not.toContain('\n\n\n')
    const full = renderTemplate(DEFAULT_USER_TEMPLATE, { ...vars, context_before: 'B', context_after: 'A', carry: 'T' })
    expect(full).toContain('transform it.\n\nThe tail')
    expect(full).toContain('</previous_output_tail>\n\n<context_before>\nB\n</context_before>\n\n<focus>\nFOCUS\n</focus>\n\n<context_after>\nA\n</context_after>\n\nReturn only')
  })
})

describe('parseTemplate: errors carry a line and column', () => {
  it('rejects an unknown tag', () => {
    const e = errorOf('line one\n  {% iff carry %}')
    expect([e.line, e.col]).toEqual([2, 3])
    expect(e.message).toContain('unknown tag')
  })
  it('rejects an end-if that names a different variable', () => {
    expect(errorOf('{% if carry %}x{% end-if focus %}').message).toContain('expected `{% end-if carry %}`')
  })
  it('rejects unclosed and unopened blocks', () => {
    expect(errorOf('{% if carry %}x').message).toContain('never closed')
    expect(errorOf('x{% end-if carry %}').message).toContain('without a matching')
    expect(errorOf('{% else %}').message).toContain('without a matching')
    expect(errorOf('{% if carry').message).toContain('never closed')
  })
  it('rejects malformed branches', () => {
    expect(errorOf('{% if x %}{% else %}{% else-if y %}{% end-if x %}').message).toContain('after `{% else %}`')
    expect(errorOf('{% if %}{% end-if x %}').message).toContain('needs a variable name')
    expect(errorOf('{% if x %}{% else x %}{% end-if x %}').message).toContain('takes no variable')
    expect(errorOf('{% if x %}{% end-if not x %}').message).toContain('without `not`')
  })
  it('has no include, render or any other file or loop tag', () => {
    expect(errorOf("{% include 'config.json' %}").message).toContain('unknown tag')
    expect(errorOf('{% for i in (1..9) %}{% endfor %}').message).toContain('unknown tag')
  })
})

describe('checkTemplate', () => {
  it('lists variables in first-use order, including conditions', () => {
    expect(checkTemplate('{% if carry %}{{carry}}{% end-if carry %} {{focus}} {{focus}} {{bogus}}').variables).toEqual(['carry', 'focus', 'bogus'])
  })
  it('reports variables Turbine will not supply', () => {
    expect(checkTemplate(DEFAULT_USER_TEMPLATE)).toEqual({ variables: expect.any(Array), unknown: [], error: null })
    expect(checkTemplate('{{focus}} {{style_guide}}').unknown).toEqual(['style_guide'])
  })
  it('returns the error instead of throwing', () => {
    const r = checkTemplate('{% if carry %}')
    expect(r.error).toBeInstanceOf(TemplateError)
    expect(r.variables).toEqual([])
  })
})

describe('migrateLegacyTemplate', () => {
  it('converts Mustache-style sections to the same output', () => {
    const old = '{{#carry}}[C:{{carry}}]{{/carry}}{{^carry}}[none]{{/carry}} {{focus}}'
    const migrated = migrateLegacyTemplate(old)
    expect(migrated).toBe('{% if carry %}[C:{{carry}}]{% end-if carry %}{% if not carry %}[none]{% end-if carry %} {{focus}}')
    expect(renderTemplate(migrated, { carry: 'tail', focus: 'F' })).toBe('[C:tail] F')
    expect(renderTemplate(migrated, { carry: '', focus: 'F' })).toBe('[none] F')
  })
  it('leaves current templates alone', () => {
    expect(migrateLegacyTemplate(DEFAULT_USER_TEMPLATE)).toBe(DEFAULT_USER_TEMPLATE)
  })
})

describe('validateJobSpec and templates', () => {
  it('converts a legacy template and rejects a malformed one with its position', async () => {
    const { defaultJobSpec, validateJobSpec, FALLBACK_WINDOW_DEFAULTS } = await import('../../shared/defaults.ts')
    const base = defaultJobSpec('doc', FALLBACK_WINDOW_DEFAULTS)
    const limits = { max_concurrency: 4 }
    expect(validateJobSpec({ ...base, userTemplate: '{{#carry}}{{carry}}{{/carry}}' }, limits).userTemplate).toBe('{% if carry %}{{carry}}{% end-if carry %}')
    expect(() => validateJobSpec({ ...base, userTemplate: 'x\n{% if carry %}' }, limits)).toThrow('spec.userTemplate: `{% if carry %}` is never closed with `{% end-if carry %}` (line 2, column 1)')
  })
})

describe('scaffoldOf and scrubOutput', () => {
  const custom = '<rules>\n{{style}}\n</rules>\n\n<passage>\n{{focus}}\n</passage>\n\nRewrite the passage per the rules above.'
  it("derives scaffolding from the template in use, on top of the default's", () => {
    const sc = scaffoldOf(custom, 'Be faithful to the source.\nOK.')
    expect(sc.unwrap.sort()).toEqual(['focus', 'passage'])
    expect(sc.drop.sort()).toEqual(['context_after', 'context_before', 'previous_output_tail', 'rules'])
    expect(sc.lines).toContain('Rewrite the passage per the rules above.')
    expect(sc.lines).toContain('Be faithful to the source.')
    expect(sc.lines).not.toContain('OK.') // too short to be sure it's ours
    expect(sc.lines.some((l) => l.includes('{{'))).toBe(false)
  })
  it('drops echoed read-only blocks with their content, unwraps the focus, removes stray tags and instruction lines', () => {
    const sc = scaffoldOf(custom)
    const raw = '<rules>\nno adverbs\n</rules>\n<passage>\nThe text, 1 < 2.\n\nSecond para.\n</passage>\nRewrite the passage per the rules above.\n</context_after>'
    const { text, removed } = scrubOutput(raw, sc)
    expect(text).toBe('The text, 1 < 2.\n\nSecond para.')
    expect(removed).toEqual([
      'echoed <rules> block (27 chars)',
      '<passage> tag',
      '</passage> tag',
      '</context_after> tag',
      'instruction line "Rewrite the passage per the rules above."',
    ])
  })
  it('leaves clean output, and tags that are not ours, exactly as they were', () => {
    const sc = scaffoldOf(DEFAULT_USER_TEMPLATE)
    const clean = 'A <b>bold</b> claim:\n\n\n\n1 < 2 and 3 > 2.'
    expect(scrubOutput(clean, sc)).toEqual({ text: clean, removed: [] })
  })
  it('only removes whole lines that repeat an instruction, not sentences that contain one', () => {
    const sc = scaffoldOf(DEFAULT_USER_TEMPLATE)
    const s = 'She wrote: Return only the transformed focus text. Then left.'
    expect(scrubOutput(s, sc).text).toBe(s)
  })
})
