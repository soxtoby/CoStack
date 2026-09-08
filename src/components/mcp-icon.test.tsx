import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { McpIcon } from './mcp-icon'

test('renders HTTPS registry icons and local bundled icons without referrers', () => {
  for (const src of ['https://example.com/icon.png', '/icons/github.svg']) {
    const html = renderToStaticMarkup(<McpIcon src={src} name="GitHub" />)
    expect(html).toContain(`<img src="${src}"`)
    expect(html).toContain('referrerPolicy="no-referrer"')
  }
})

test('missing or unsupported icon URLs use a consistent fallback', () => {
  for (const src of [
    undefined,
    'javascript:alert(1)',
    '//example.com/icon.svg',
    'http://example.com/icon.png',
  ]) {
    const html = renderToStaticMarkup(<McpIcon src={src} name="GitHub" />)
    expect(html).not.toContain('<img')
    expect(html).toContain('>G</span>')
  }
})
