import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { bundledMcps, bundledPrefill } from '../connections/bundled-mcps'
import {
  ConnectionForm,
  ConnectionSummary,
  ConnectionsEmptyState,
  DeleteConnectionForm,
} from './control-app'

test('delete confirmation spells out what is lost and what is kept', () => {
  const html = renderToStaticMarkup(
    <DeleteConnectionForm
      displayName="Linear"
      namespace="linear"
      cancel={() => {}}
      confirm={() => Promise.resolve()}
    />,
  )
  expect(html).toContain('Deleting <b>Linear</b>')
  expect(html).toContain('every Shared and Personal Account')
  expect(html).toContain('credentials belonging to other Users')
  expect(html).toContain('Audit records are kept.')
  expect(html).toContain('<code>linear__*</code>')
  expect(html).toContain('>Cancel</button>')
  expect(html).toContain('Delete connection')
})

test('empty connections explain the available next step', () => {
  expect(
    renderToStaticMarkup(<ConnectionsEmptyState canAdd={true} />),
  ).toContain('Choose Add connection to get started.')
  expect(
    renderToStaticMarkup(<ConnectionsEmptyState canAdd={false} />),
  ).toContain('Ask an administrator to add a connection.')
})

test('collapsed connection summary shows its visible Account count', () => {
  const html = renderToStaticMarkup(
    <ConnectionSummary
      connection={{
        id: 'linear',
        display_name: 'Linear',
        namespace: 'linear',
        transport: 'streamable_http',
        state: 'enabled',
        revision: 1,
        healthy: true,
        error: null,
        account_count: 2,
        icon: '/icons/linear.svg',
        group_ids: [],
      }}
      expanded={false}
      select={() => {}}
    />,
  )
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('2 Accounts')
  expect(html).toContain('linear__*')
  expect(html).toContain('<img src="/icons/linear.svg"')
})

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
