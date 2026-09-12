import { evaluateToolPolicy, validateGlob } from '../connections/policy'
import { RevisionConflictError } from '../connections/manager'
import type { ToolPolicy } from '../connections/types'
import type { Pool } from 'pg'

export const builtinConnectionId = 'costack'
export const builtinTools = [
  {
    name: 'search_tools',
    description: 'Search tools available through this gateway',
  },
  { name: 'call_tool', description: 'Call an allowed gateway tool' },
  {
    name: 'call_tool_with_approval',
    description: 'Call a tool after the client has obtained user approval',
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
