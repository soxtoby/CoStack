import { expect, test } from 'bun:test'
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRouter,
} from '@tanstack/react-router'
import { renderToStaticMarkup } from 'react-dom/server'
import { bundledMcps } from '../connections/bundled-mcps'
import { AccountForm, ConnectionDetail } from './control-app'
import type { ReactNode } from 'react'

test('ConnectionDetail for a connection manager on a connection without Group access hides Add Account and explains why', async () => {
  const result = await render(
    <ConnectionDetail
      detail={detail({ group_ids: [], personal_account_eligible: false })}
      canConnections={true}
      canAccounts={false}
      reload={() => {}}
    />,
  )

  expect(result).not.toContain('>Add Account</button>')
  expect(result).toContain('No Group has access to this connection yet')
  expect(result).toContain('assign a Group under Group access')
})

test('ConnectionDetail for an administrator outside the assigned Groups offers Add Account and explains Personal sign-in', async () => {
  const result = await render(
    <ConnectionDetail
      detail={detail({ group_ids: ['ops'], personal_account_eligible: false })}
      canConnections={true}
      canAccounts={true}
      reload={() => {}}
    />,
  )

  expect(result).toContain('>Add Account</button>')
  expect(result).toContain('Personal sign-in requires a Group you belong to.')
})

test('AccountForm for an account manager outside the assigned Groups starts on Shared', () => {
  const result = renderToStaticMarkup(
    accountForm({ shared: true, personalEligible: false }),
  )

  expect(result).toContain('class="on">Shared</button>')
  expect(result).not.toContain('Personal Accounts require membership')
  expect(result).toContain('<button class="primary">')
})

test('AccountForm for an ineligible Personal Account explains the disabled submit', () => {
  const result = renderToStaticMarkup(
    accountForm({ shared: false, personalEligible: false }),
  )

  expect(result).toContain(
    'Personal Accounts require membership in a Group with access to this connection.',
  )
  expect(result).toContain('<button class="primary" disabled="">')
})

test('AccountForm for saved manual HTTP credentials reopens in manual mode with the stored header names', () => {
  const result = renderToStaticMarkup(
    <AccountForm
      account={{
        id: 'account',
        kind: 'personal',
        display_name: 'Manual account',
        namespace: 'manual',
        has_secret: true,
        secret_names: ['Authorization', 'X-Api-Key'],
      }}
      connectionId="linear"
      shared={false}
      oauth={true}
      personalEligible={true}
      bundled={bundledMcps.find((entry) => entry.id == 'linear')}
      cancel={() => {}}
      done={() => {}}
    />,
  )

  expect(result).toContain('type="checkbox" checked=""')
  const headers = result.match(
    /<textarea[^>]*name="secrets"[^>]*>([\s\S]*?)<\/textarea>/,
  )?.[1]
  expect(headers).toBeDefined()
  expect(JSON.parse(headers!.replaceAll('&quot;', '"'))).toEqual({
    Authorization: '',
    'X-Api-Key': '',
  })
  expect(result).toContain('Leave a value blank to keep it')
  expect(result).toContain('Save credentials')
})

test('AccountForm for saved OAuth credentials reopens with OAuth sign-in', () => {
  const result = renderToStaticMarkup(
    <AccountForm
      account={{
        id: 'account',
        kind: 'personal',
        display_name: 'OAuth account',
        namespace: 'oauth',
        has_secret: true,
        secret_names: [],
      }}
      connectionId="linear"
      shared={false}
      oauth={true}
      personalEligible={true}
      bundled={undefined}
      cancel={() => {}}
      done={() => {}}
    />,
  )

  expect(result).toContain('Sign in with OAuth')
  expect(result).not.toContain('name="secrets"')
})

async function render(node: ReactNode) {
  const router = createRouter({
    routeTree: createRootRoute({ component: () => node }),
    history: createMemoryHistory(),
  })
  await router.load()
  return renderToStaticMarkup(<RouterProvider router={router} />)
}

function detail(
  access: Pick<
    NonNullable<Parameters<typeof ConnectionDetail>[0]['detail']>,
    'group_ids' | 'personal_account_eligible'
  >,
) {
  return {
    id: 'linear',
    display_name: 'Linear',
    namespace: 'linear',
    transport: 'streamable_http',
    transport_config: { kind: 'streamable_http', url: 'https://example.test' },
    state: 'enabled' as const,
    revision: 1,
    has_oauth: false,
    policies: [],
    tools: [],
    accounts: [],
    ...access,
  }
}

function accountForm(access: { shared: boolean; personalEligible: boolean }) {
  return (
    <AccountForm
      connectionId="linear"
      oauth={false}
      bundled={undefined}
      cancel={() => {}}
      done={() => {}}
      {...access}
    />
  )
}
