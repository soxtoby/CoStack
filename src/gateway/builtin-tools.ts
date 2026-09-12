import { evaluateToolPolicy, validateGlob } from '../connections/policy'
import { RevisionConflictError } from '../connections/manager'
import type { ToolPolicy } from '../connections/types'
import type { Pool } from 'pg'

export const builtinConnectionId = 'costack'
export const builtinTools = [
  {
    name: 'search_tools',
    description:
      'Discover tools from connected services. Upstream tools are not individually listed in your tool inventory. Search here before concluding a service or capability is unavailable. Use a task-specific query with the service and operation first, such as "linear list teams"; omit task filters such as "assigned to me" or "recently". Search matches whitespace-separated terms across service name, tool name, account name, or description. For longer natural-language queries with no exact match, trailing detail terms are progressively ignored. Returns qualified tool names, complete input schemas, availability, and approval requirements. Once a suitable tool and schema are returned, invoke it using call_tool without another discovery search. Reuse results for subsequent calls; search again only when a needed tool is missing or a call reports it unavailable. Omit query only when you need the full accessible catalog.',
  },
  {
    name: 'call_tool',
    description:
      'Execute a connected service tool discovered with search_tools. Pass its qualifiedName as name and arguments matching its inputSchema. Gateway-enforced approval is requested when required; client-managed approval uses call_tool_with_approval.',
  },
  {
    name: 'call_tool_with_approval',
    description:
      'Execute an approval-required tool discovered with search_tools after the client has obtained user approval for this exact call. Pass its qualifiedName as name and arguments matching its inputSchema. Use call_tool for tools that do not require approval.',
  },
]

export async function builtinConnection(pool: Pool) {
  const { rows } = await pool.query(
    'SELECT tool_policies,tool_policy_revision FROM gateway_settings WHERE singleton',
  )
  const policies = rows[0].tool_policies as Array<ToolPolicy>
  return {
    id: builtinConnectionId,
    builtin: true,
    display_name: 'CoStack',
    namespace: '',
    transport: 'builtin',
    transport_config: {},
    state: 'enabled',
    revision: rows[0].tool_policy_revision as number,
    healthy: true,
    error: null,
    account_count: 0,
    group_ids: [],
    accounts: [],
    has_oauth: false,
    personal_account_eligible: false,
    policies,
    tools: builtinTools.map((tool) => ({
      ...tool,
      policy: evaluateToolPolicy(policies, tool.name),
    })),
  }
}

export async function setBuiltinToolPolicies(
  pool: Pool,
  revision: number,
  policies: Array<ToolPolicy>,
) {
  for (const policy of policies) {
    validateGlob(policy.pattern)
    if (!['allow', 'block', 'require_approval'].includes(policy.effect))
      throw new Error('Invalid policy action')
  }
  const result = await pool.query(
    'UPDATE gateway_settings SET tool_policies=$1,tool_policy_revision=tool_policy_revision+1 WHERE singleton AND tool_policy_revision=$2',
    [JSON.stringify(policies), revision],
  )
  if (result.rowCount !== 1)
    throw new RevisionConflictError('Connection changed; reload and retry')
  return { revision: revision + 1 }
}
