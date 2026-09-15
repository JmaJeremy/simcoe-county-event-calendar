import { describe, expect, it } from 'vitest'
import { descriptionHtml, descriptionText } from '../src/markdown.ts'

describe('descriptionHtml', () => {
  it('keeps paragraphs and line breaks', () => {
    expect(descriptionHtml('One\nTwo\n\nThree')).toBe('<p>One<br>Two</p><p>Three</p>')
  })

  it('renders bold and italic, as sources already type them', () => {
    expect(descriptionHtml('Come to **Global Pet Foods** for *Free* admission')).toBe(
      '<p>Come to <strong>Global Pet Foods</strong> for <em>Free</em> admission</p>',
    )
  })

  it('leaves a lone or arithmetic star alone', () => {
    for (const text of ['Tickets $10*', '2*3*4 = 24', '*Registration required', 'a * b', '*No purchase necessary* *Tickets NOT REQUIRED']) {
      const html = descriptionHtml(text)
      expect(html.match(/<em>/g)?.length ?? 0, text).toBe(text.startsWith('*No') ? 1 : 0)
    }
  })

  it('links markdown links and bare addresses, keeping punctuation outside', () => {
    expect(descriptionHtml('[Tickets](https://example.org/t?a=1&b=2) or see https://example.org.')).toBe(
      '<p><a href="https://example.org/t?a=1&amp;b=2" rel="nofollow noopener noreferrer">Tickets</a> or see ' +
        '<a href="https://example.org" rel="nofollow noopener noreferrer">https://example.org</a>.</p>',
    )
  })

  it('leaves a trailing ellipsis outside the link', () => {
    expect(descriptionHtml('Register: https://example.org/workshop-intuiti…')).toContain('>https://example.org/workshop-intuiti</a>…')
  })

  it('never links anything but http(s), and escapes everything it does not add', () => {
    const html = descriptionHtml('[click](javascript:alert(1)) <script>alert(1)</script> <img src=x onerror=y>')
    expect(html).not.toContain('<a')
    expect(html).not.toContain('<script')
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;script&gt;')
  })

  it('cannot break out of an href', () => {
    expect(descriptionHtml('https://example.org/"onmouseover="x')).not.toContain('"onmouseover')
  })

  it('makes a list from "- " or "* " lines, around ordinary text', () => {
    expect(descriptionHtml('Bring:\n- a chair\n* **sunscreen**\nSee you there')).toBe(
      '<p>Bring:</p><ul><li>a chair</li><li><strong>sunscreen</strong></li></ul><p>See you there</p>',
    )
  })

  it('reads ***both*** and never crosses its tags', () => {
    expect(descriptionHtml('***Limited spots!***')).toBe('<p><strong><em>Limited spots!</em></strong></p>')
    const lopsided = descriptionHtml('***Limited spots!** Register *now*')
    expect(lopsided).toBe('<p><strong>*Limited spots!</strong> Register <em>now</em></p>')
  })

  it('keeps a backslash-escaped star as a star', () => {
    expect(descriptionHtml('\\*NEW LOCATION\\* at the hall')).toBe('<p>*NEW LOCATION* at the hall</p>')
    expect(descriptionText('\\*Richi\\*')).toBe('*Richi*')
  })

  it('does not treat headings, underscores or images as markdown', () => {
    expect(descriptionHtml('# Big\nsnake_case_name ![x](https://example.org/x.png)')).toContain('# Big<br>snake_case_name !')
  })
})

describe('descriptionText', () => {
  it('drops the markdown and keeps the words and addresses', () => {
    expect(descriptionText('**Bold** and *soft* [tickets](https://example.org)\n* item')).toBe('Bold and soft tickets (https://example.org)\n- item')
  })
})
