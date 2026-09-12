import { describe, expect, test } from 'bun:test'

describe('gateway HTTP boundary', () => {
  test('source mounts MCP before the app and exposes auth discovery', async () => {
    const source = await Bun.file(
      new URL('../../server.ts', import.meta.url),
    ).text()
    expect(source.indexOf("url.pathname === '/mcp'")).toBeLessThan(
      source.indexOf('serverEntry.fetch'),
    )
    expect(source).toContain("url.pathname.startsWith('/.well-known/')")

    const developmentRoute = await Bun.file(
      new URL('../routes/[.]well-known.$.ts', import.meta.url),
    ).text()
    expect(developmentRoute).toContain("createFileRoute('/.well-known/$')")
    expect(developmentRoute).toContain('authHandler(request)')
  })
})
