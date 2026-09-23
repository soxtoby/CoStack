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
