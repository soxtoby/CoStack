import { describe, expect, test } from 'bun:test'
import { evaluateToolPolicy } from './policy'
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
  test('creates an unsaved, blocked Bun connection prefill', () => {
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
    expect(result.policies).toEqual([{ pattern: '*', effect: 'block' }])
    expect(result.state).toBe('disabled')
  })
})
