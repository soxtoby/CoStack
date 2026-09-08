import { expect, test } from 'bun:test'
import {
  bundledMcps,
  bundledPrefill,
  findBundledMcp,
  isBundledRegistryEntry,
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

test('prefills a disabled blocked connection without registry access or fictional provenance', () => {
  const github = bundledMcps.find((entry) => entry.id === 'github')!
  const input = bundledPrefill(github, 'org')
  expect(input).toEqual({
    organizationId: 'org',
    displayName: 'GitHub',
    transport: {
      kind: 'streamable_http',
      url: 'https://api.githubcopilot.com/mcp/',
    },
    state: 'disabled',
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
