import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { bundledMcps, bundledPrefill } from '../connections/bundled-mcps'
import { ConnectionForm } from './control-app'

test('Teams review provides a required tenant ID input before saving', () => {
  const entry = bundledMcps.find((mcp) => mcp.id === 'microsoft-teams')!
  const html = renderToStaticMarkup(
    <ConnectionForm
      data={{ state: 'ready' }}
      organizationId="org"
      initial={bundledPrefill(entry, 'org')}
      done={() => {}}
    />,
  )
  expect(html).toContain('Microsoft Entra tenant ID')
  expect(html).toContain('name="tenantId"')
  expect(html.match(/<input[^>]*name="tenantId"[^>]*>/)?.[0]).toContain(
    'required=""',
  )
})
