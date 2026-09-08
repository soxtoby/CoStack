import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { bundledMcps } from '../connections/bundled-mcps'
import { BundledMcpCards, BundledMcpSetup } from './bundled-mcps'

test('renders an actionable GitHub card without registry data or network access', () => {
  const html = renderToStaticMarkup(<BundledMcpCards select={() => {}} />)
  expect(html).toContain('Add GitHub')
  expect(html).not.toContain('disabled')
  expect(html).toContain('Documentation')
  expect(html).toContain('/icons/github.svg')
  expect(html).toContain('>Add</button>')
})

test('explains GitHub credential setup', () => {
  const html = renderToStaticMarkup(
    <BundledMcpSetup
      entry={bundledMcps.find((entry) => entry.id === 'github')}
    />,
  )
  expect(html).toContain('Use manual credentials instead')
  expect(html).toContain('Authorization')
  expect(html).toContain('Bearer YOUR_GITHUB_TOKEN')
})
