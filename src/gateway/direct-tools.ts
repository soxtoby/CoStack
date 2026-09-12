import { GatewayError } from './service'
import type { GatewayTool } from './types'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'

export type DirectTool = {
  definition: Tool
  accounts: Array<GatewayTool>
}

// The connection catalog owns the schema; accounts only select credentials.
export function directTools(tools: Array<GatewayTool>): Array<DirectTool> {
  const groups = new Map<string, Array<GatewayTool>>()
  for (const tool of tools) {
    const name = `${tool.connectionNamespace}.${tool.toolName}`
    const group = groups.get(name) ?? []
    group.push(tool)
    groups.set(name, group)
  }
  return [...groups].map(([name, accounts]) => {
    const tool = accounts[0]!
    const selectors = accounts.flatMap((account) =>
      account.accountNamespace ? [account.accountNamespace] : [],
    )
    const approval = tool.policy === 'require_approval'
    return {
      accounts,
      definition: {
        name,
        description:
          `${tool.connectionName}: ${tool.description ?? tool.toolName}. ` +
          'Pass upstream parameters in arguments. ' +
          (selectors.length
            ? `Accounts (namespace: name, kind): ${accounts.map((account) => `${account.accountNamespace}: ${account.accountName}, ${account.accountKind}`).join('; ')}. `
            : '') +
          (approval
            ? 'Requires approval. With client-managed approval, obtain user approval for this exact account and arguments before calling.'
            : ''),
        inputSchema: {
          type: 'object',
          properties: {
            ...(selectors.length
              ? {
                  account: {
                    type: 'string',
                    enum: selectors,
                    description:
                      'Account namespace from the listed choices. Required when multiple accounts are accessible.',
                  },
                }
              : {}),
            arguments: {
              // A nested schema resource keeps local $refs rooted upstream.
              $id: `urn:costack:input:${encodeURIComponent(name)}`,
              ...tool.inputSchema,
            },
          },
          required:
            selectors.length > 1 ? ['account', 'arguments'] : ['arguments'],
          additionalProperties: false,
        },
        annotations: { destructiveHint: true, openWorldHint: true },
      },
    }
  })
}

export function selectAccount(tool: DirectTool, selector: unknown) {
  const matches =
    selector === undefined
      ? tool.accounts
      : tool.accounts.filter((account) => account.accountNamespace === selector)
  if (matches.length !== 1)
    throw new GatewayError(
      'Select an accessible account using the account namespace from the tool schema',
      'account_required',
    )
  return matches[0]!
}
