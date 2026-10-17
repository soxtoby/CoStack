import { expect, test } from 'bun:test'
import { McpUpstreamClient } from './upstream'

test('STDIO servers that exit report their stderr instead of "Connection closed"', async () => {
  await expect(
    McpUpstreamClient.connect(
      {
        kind: 'stdio',
        command: process.execPath,
        args: ['-e', "console.error('missing SEQ_URL'); process.exit(2)"],
      },
      {},
    ),
  ).rejects.toThrow('Server process exited: missing SEQ_URL')
})

test('HTTP servers that reject the credentials explain re-authorization instead of a bare 401', async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      new Response(null, {
        status: 401,
        headers: { 'WWW-Authenticate': 'Bearer realm="OAuth"' },
      }),
  })
  try {
    await expect(
      McpUpstreamClient.connect(
        { kind: 'streamable_http', url: `http://127.0.0.1:${server.port}/mcp` },
        {},
      ),
    ).rejects.toThrow("rejected the Account's credentials (HTTP 401)")
  } finally {
    server.stop(true)
  }
})
