import { expect, test } from 'bun:test'
import { formatStdioCommandLine, parseStdioCommandLine } from './stdio'

test('STDIO command lines preserve the executable and exact arguments', () => {
  const args = ['@scope/server@1.2.3', '--label', 'two words']
  expect(parseStdioCommandLine(formatStdioCommandLine('bunx', args))).toEqual({
    command: 'bunx',
    args,
  })
})

test('STDIO command lines support quoted executables and arguments', () => {
  expect(
    parseStdioCommandLine(
      '"C:\\Program Files\\server.exe" --label "two words"',
    ),
  ).toEqual({
    command: 'C:\\Program Files\\server.exe',
    args: ['--label', 'two words'],
  })
})
