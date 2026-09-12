export function parseStdioCommandLine(value: string) {
  const parts: Array<string> = []
  let part = ''
  let quote = ''
  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (quote) {
      if (character === quote) quote = ''
      else if (character === '\\' && value[index + 1] === quote)
        part += value[++index]
      else part += character
    } else if (character === '"' || character === "'") quote = character
    else if (/\s/.test(character)) {
      if (part) {
        parts.push(part)
        part = ''
      }
    } else part += character
  }
  if (quote) throw new Error('Launch command has an unclosed quote')
  if (part) parts.push(part)
  const [command, ...args] = parts
  if (!command) throw new Error('Launch command is required')
  return { command, args }
}

export function formatStdioCommandLine(
  command: string,
  arguments_: Array<string> | undefined,
) {
  return [command, ...(arguments_ ?? [])]
    .map((part) =>
      /\s|["']/.test(part) ? `"${part.replaceAll('"', '\\"')}"` : part,
    )
    .join(' ')
}
