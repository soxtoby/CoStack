import { describe, expect, test } from 'bun:test'
import { OFFICIAL_REGISTRY } from './registry'
import { rankRegistryServers } from './registry-ranking'
import type { RegistryServer } from './registry'

function entry(
  name: string,
  url: string,
  type = 'streamable-http',
): RegistryServer {
  return { server: { name, version: '1', remotes: [{ type, url }] } }
}

describe('publisher-hosted registry ranking', () => {
  test.each([
    ['com.example/mcp', 'https://example.com/mcp'],
    ['com.example/mcp', 'https://mcp.example.com/mcp'],
    ['uk.co.example/mcp', 'https://mcp.example.co.uk/mcp'],
    ['com.example.api/mcp', 'https://mcp.api.example.com/mcp'],
    ['com.example/mcp', 'https://MCP.EXAMPLE.COM./mcp'],
  ])('recognizes %s at %s', (name, url) => {
    expect(
      rankRegistryServers([entry(name, url)], OFFICIAL_REGISTRY)[0]!
        .publisherHosted,
    ).toBe(true)
  })

  test.each([
    ['com.example/mcp', 'https://example.com.evil.org/mcp'],
    ['com.example/mcp', 'https://notexample.com/mcp'],
    ['com.example/mcp', 'https://example.com@evil.org/mcp'],
    ['com.example/mcp', 'http://mcp.example.com/mcp'],
    ['com.example/mcp', 'https://hosting.example.net/mcp'],
    ['com.example/mcp', 'not a URL'],
    ['com.example.api/mcp', 'https://example.com/mcp'],
    ['io.github.example/mcp', 'https://example.github.io/mcp'],
    ['io.github/mcp', 'https://github.io/mcp'],
    ['example/mcp', 'https://example/mcp'],
    ['com..example/mcp', 'https://example..com/mcp'],
  ])('does not boost %s at %s', (name, url) => {
    expect(
      rankRegistryServers([entry(name, url)], OFFICIAL_REGISTRY)[0]!
        .publisherHosted,
    ).toBe(false)
  })

  test('requires a Streamable HTTP remote', () => {
    const entries = [
      entry('com.example/sse', 'https://example.com/mcp', 'sse'),
      { server: { name: 'com.example/package', version: '1' } },
    ]
    expect(
      rankRegistryServers(entries, OFFICIAL_REGISTRY).map(
        (result) => result.publisherHosted,
      ),
    ).toEqual([false, false])
  })

  test('checks all remotes, including after an invalid URL', () => {
    const server = entry('com.example/mcp', 'invalid')
    server.server.remotes!.push({
      type: 'streamable-http',
      url: 'https://example.com/mcp',
    })
    expect(
      rankRegistryServers([server], OFFICIAL_REGISTRY)[0]!.publisherHosted,
    ).toBe(true)
  })

  test('does not assume custom registries verify namespaces', () => {
    const server = entry('com.example/mcp', 'https://example.com/mcp')
    expect(
      rankRegistryServers([server], 'https://registry.example.com')[0]!
        .publisherHosted,
    ).toBe(false)
    expect(
      rankRegistryServers([server], `${OFFICIAL_REGISTRY}/`)[0]!
        .publisherHosted,
    ).toBe(true)
  })

  test('boosts later pages without mutating results or changing order within either group', () => {
    const community = entry('com.community/first', 'https://example.com/mcp')
    const hosted = entry('com.example/second', 'https://example.com/mcp')
    const nextCommunity = entry(
      'com.community/third',
      'https://example.com/mcp',
    )
    const nextHosted = entry('com.example/fourth', 'https://example.com/mcp')
    const entries = [community, hosted, nextCommunity, nextHosted]
    const ranked = rankRegistryServers(entries, OFFICIAL_REGISTRY)
    expect(ranked.map(({ server }) => server.name)).toEqual([
      hosted.server.name,
      nextHosted.server.name,
      community.server.name,
      nextCommunity.server.name,
    ])
    expect(entries).toEqual([community, hosted, nextCommunity, nextHosted])
    expect(community).not.toHaveProperty('publisherHosted')
  })
})
