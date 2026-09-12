import { expect, test } from 'bun:test'
import {
  bundledMcps,
  bundledPrefill,
  findBundledMcp,
  isBundledRegistryEntry,
  resolveBundledTransport,
  searchBundledMcps,
} from './bundled-mcps'
import { OFFICIAL_REGISTRY } from './registry'

test('finds GitHub immediately and by name, alias, or multiple words', () => {
  for (const query of ['', ' GITHUB ', 'git', 'pull requests']) {
    expect(searchBundledMcps(query).map((entry) => entry.id)).toContain(
      'github',
    )
  }
  expect(searchBundledMcps('unrelatedxyz')).toEqual([])
})

test('prefills an enabled blocked connection without registry access or fictional provenance', () => {
  const github = bundledMcps.find((entry) => entry.id === 'github')!
  const input = bundledPrefill(github, 'org')
  expect(input).toEqual({
    organizationId: 'org',
    displayName: 'GitHub',
    transport: {
      kind: 'streamable_http',
      url: 'https://api.githubcopilot.com/mcp/',
    },
    state: 'enabled',
    groupIds: [],
    policies: [{ pattern: '*', effect: 'block' }],
  })
  expect(input.transport).not.toBe(github.transport)
  expect(
    findBundledMcp({
      url: 'https://api.githubcopilot.com/mcp/',
      kind: 'streamable_http',
    })?.id,
  ).toBe('github')
})

test('deduplicates only visible bundled entries from the official registry', () => {
  const entry = {
    server: { name: 'io.github.github/github-mcp-server', version: '1' },
  }
  expect(isBundledRegistryEntry(entry, OFFICIAL_REGISTRY, 'github')).toBe(true)
  expect(
    isBundledRegistryEntry(entry, 'https://private.example', 'github'),
  ).toBe(false)
  expect(isBundledRegistryEntry(entry, OFFICIAL_REGISTRY, 'unrelatedxyz')).toBe(
    false,
  )
  expect(
    isBundledRegistryEntry(
      { server: { name: 'io.github.community/github', version: '1' } },
      OFFICIAL_REGISTRY,
      'github',
    ),
  ).toBe(false)
})

test('retains Teams setup for a configured tenant without matching unrelated URLs', () => {
  const url =
    'https://agent365.svc.cloud.microsoft/agents/tenants/12345678-abcd-1234-abcd-123456789abc/servers/mcp_TeamsServer'
  expect(findBundledMcp({ kind: 'streamable_http', url })?.id).toBe(
    'microsoft-teams',
  )
  for (const unrelated of [
    url.replace('agent365.svc.cloud.microsoft', 'example.com'),
    url.replace('mcp_TeamsServer', 'mcp_WordServer'),
    url.replace('12345678-abcd-1234-abcd-123456789abc', 'invalid'),
    `${url}/extra`,
  ]) {
    expect(
      findBundledMcp({ kind: 'streamable_http', url: unrelated }),
    ).toBeUndefined()
  }
})

test('resolves the Teams tenant before saving and rejects missing or invalid IDs', () => {
  const teams = bundledMcps.find((entry) => entry.id === 'microsoft-teams')!
  const tenantId = '12345678-abcd-1234-abcd-123456789abc'
  expect(resolveBundledTransport(teams.transport, ` ${tenantId} `)).toEqual({
    kind: 'streamable_http',
    url: `https://agent365.svc.cloud.microsoft/agents/tenants/${tenantId}/servers/mcp_TeamsServer`,
  })
  for (const invalid of ['', 'example.com', '{tenantId}']) {
    expect(() => resolveBundledTransport(teams.transport, invalid)).toThrow(
      'tenant ID',
    )
  }
  expect(teams.transport).toHaveProperty(
    'url',
    'https://agent365.svc.cloud.microsoft/agents/tenants/{tenantId}/servers/mcp_TeamsServer',
  )
})

test('catalog entries have unique IDs, vendor documentation, and setup instructions', () => {
  expect(new Set(bundledMcps.map((entry) => entry.id)).size).toBe(
    bundledMcps.length,
  )
  for (const entry of bundledMcps) {
    expect(new URL(entry.documentationUrl).protocol).toBe('https:')
    expect(entry.setup.trim().length).toBeGreaterThan(0)
    expect(searchBundledMcps(entry.displayName)).toContain(entry)
    if (entry.transport.kind === 'streamable_http')
      expect(new URL(entry.transport.url).protocol).toBe('https:')
  }
})

test('prefills Linear manual credentials with its authorization header', () => {
  expect(
    bundledMcps.find((entry) => entry.id === 'linear')?.manualCredentials,
  ).toBe('{"Authorization":"Bearer YOUR_LINEAR_API_KEY"}')
})
