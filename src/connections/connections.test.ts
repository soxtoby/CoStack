import { describe, expect, test } from 'bun:test'
import { evaluateToolPolicy, setToolPolicy } from './policy'
import { RegistryClient } from './registry'
import { SecretVault } from './secrets'
import { validateHttpUrl } from './upstream'

describe('tool policy', () => {
  test('most-specific policy wins and equal block wins', () => {
    const policies = [
      { pattern: '*', effect: 'block' as const },
      { pattern: 'read_*', effect: 'allow' as const },
      { pattern: 'read_secret', effect: 'require_approval' as const },
      { pattern: 'read_secret', effect: 'block' as const },
    ]
    expect(evaluateToolPolicy(policies, 'read_issue')).toBe('allow')
    expect(evaluateToolPolicy(policies, 'read_secret')).toBe('block')
    expect(evaluateToolPolicy(policies, 'write_issue')).toBe('block')
  })

  test('setting a tool action adds a rule only when the rules disagree', () => {
    const policies = [
      { pattern: '*', effect: 'block' as const },
      { pattern: 'read_*', effect: 'allow' as const },
    ]
    expect(setToolPolicy(policies, 'delete_issue', 'allow')).toEqual([
      ...policies,
      { pattern: 'delete_issue', effect: 'allow' },
    ])
    expect(setToolPolicy(policies, 'read_issue', 'allow')).toEqual(policies)
  })

  test('setting a tool action replaces that tool own rule', () => {
    const policies = [
      { pattern: '*', effect: 'block' as const },
      { pattern: 'read_issue', effect: 'allow' as const },
    ]
    const changed = setToolPolicy(policies, 'read_issue', 'require_approval')
    expect(changed).toEqual([
      { pattern: '*', effect: 'block' },
      { pattern: 'read_issue', effect: 'require_approval' },
    ])
    expect(evaluateToolPolicy(changed, 'read_issue')).toBe('require_approval')
  })

  test('choosing the inherited action removes a now-redundant rule', () => {
    const policies = [
      { pattern: '*', effect: 'block' as const },
      { pattern: 'read_*', effect: 'allow' as const },
      { pattern: 'read_issue', effect: 'require_approval' as const },
    ]
    expect(setToolPolicy(policies, 'read_issue', 'allow')).toEqual([
      { pattern: '*', effect: 'block' },
      { pattern: 'read_*', effect: 'allow' },
    ])
  })
})

describe('secret vault', () => {
  test('round trips authenticated ciphertext and rejects tampering', async () => {
    const vault = await SecretVault.fromBase64(
      crypto.getRandomValues(new Uint8Array(32)).toBase64(),
    )
    const envelope = await vault.seal({ Authorization: 'Bearer secret' })
    expect(await vault.open(envelope)).toEqual({
      Authorization: 'Bearer secret',
    })
    envelope.ciphertext[0]! ^= 1
    await expect(vault.open(envelope)).rejects.toThrow()
  })
})

describe('HTTP transport', () => {
  test('requires TLS except for loopback', () => {
    expect(() => validateHttpUrl('https://mcp.example.test')).not.toThrow()
    expect(() => validateHttpUrl('http://127.0.0.1:3000')).not.toThrow()
    expect(() => validateHttpUrl('http://mcp.example.test')).toThrow()
  })
})

describe('registry import', () => {
  test('browses without a server name and preserves search and pagination parameters', async () => {
    const urls: Array<URL> = []
    const page = {
      servers: [{ server: { name: 'io.example/github', version: '1.2.3' } }],
      metadata: { nextCursor: 'next/page+1' },
    }
    const request = ((input: string | URL | Request) => {
      urls.push(new URL(String(input)))
      return Promise.resolve(Response.json(page))
    }) as typeof fetch
    const registry = new RegistryClient(
      'https://registry.example.test',
      request,
    )
    expect(await registry.list()).toEqual(page)
    expect(urls[0]!.pathname).toBe('/v0.1/servers')
    expect(urls[0]!.searchParams.has('search')).toBe(false)
    expect(urls[0]!.searchParams.get('version')).toBe('latest')
    await registry.list(' git hub ', page.metadata.nextCursor)
    expect(urls[1]!.searchParams.get('search')).toBe('git hub')
    expect(urls[1]!.searchParams.get('cursor')).toBe('next/page+1')
  })

  test('reports registry failures', async () => {
    const registry = new RegistryClient('https://registry.example.test', (() =>
      Promise.resolve(
        new Response(null, { status: 503 }),
      )) as unknown as typeof fetch)
    await expect(registry.list()).rejects.toThrow('Registry returned 503')
  })

  test('imports the selected version with registry provenance and HTTP settings', async () => {
    let requested: URL | undefined
    const registry = new RegistryClient('https://registry.example.test', ((
      input: string | URL | Request,
    ) => {
      requested = new URL(String(input))
      return Promise.resolve(
        Response.json({
          server: {
            name: 'io.example/github',
            version: '1.2.3',
            remotes: [
              { type: 'streamable-http', url: 'https://mcp.example.test/mcp' },
            ],
          },
        }),
      )
    }) as typeof fetch)
    const entry = await registry.get('io.example/github', '1.2.3')
    expect(requested!.pathname).toBe(
      '/v0.1/servers/io.example%2Fgithub/versions/1.2.3',
    )
    const input = registry.prefill(entry, 'org', 'source')
    expect(input.registry).toEqual({
      sourceId: 'source',
      serverId: 'io.example/github',
      version: '1.2.3',
    })
    expect(input.transport).toEqual({
      kind: 'streamable_http',
      url: 'https://mcp.example.test/mcp',
    })
    expect(input.state).toBe('enabled')
  })

  test('creates an unsaved Bun connection prefill with annotation defaults', () => {
    const registry = new RegistryClient()
    const result = registry.prefill(
      {
        server: {
          name: 'io.example/github',
          version: '1.2.3',
          packages: [
            {
              registryType: 'npm',
              identifier: '@example/github-mcp',
              version: '1.2.3',
            },
          ],
        },
      },
      'org',
      'registry',
    )
    expect(result.transport).toEqual({
      kind: 'stdio',
      command: 'bunx',
      args: ['@example/github-mcp@1.2.3'],
    })
    expect(result.policies).toEqual([
      { pattern: '*', effect: 'block' },
      { annotation: 'read_only', effect: 'allow' },
      { annotation: 'destructive', effect: 'require_approval' },
    ])
    expect(result.state).toBe('enabled')
  })

  test('creates a dnx command for a NuGet tool package', () => {
    const registry = new RegistryClient()
    const result = registry.prefill(
      {
        server: {
          name: 'com.example/server',
          version: '1.2.3',
          packages: [
            {
              registryType: 'nuget',
              identifier: 'Example.Mcp.Server',
              version: '1.2.3',
              packageArguments: [{ value: '--transport' }, { value: 'stdio' }],
            },
          ],
        },
      },
      'org',
      'registry',
    )
    expect(result.transport).toEqual({
      kind: 'stdio',
      command: 'dnx',
      args: ['Example.Mcp.Server@1.2.3', '--', '--transport', 'stdio'],
    })
  })
})
