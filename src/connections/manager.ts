import { randomUUID } from 'node:crypto'
import { deriveNamespace } from './namespace'
import { policyFromRow, validateToolPolicy } from './policy'
import { McpUpstreamClient, validateHttpUrl } from './upstream'
import { UpstreamOAuth } from './oauth'
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js'
import type { SecretVault } from './secrets'
import type { UpstreamClient } from './upstream'
import type {
  AccountSummary,
  ConnectionInput,
  DiscoveredTool,
  OAuthClientConfig,
  ToolPolicy,
  TransportConfig,
} from './types'
import type { Pool, PoolClient } from 'pg'

type Connect = (
  config: TransportConfig,
  secrets: Record<string, string>,
  authProvider?: OAuthClientProvider,
) => Promise<UpstreamClient>

export class RevisionConflictError extends Error {}

export class ConnectionManager {
  async setToolPolicies(
    id: string,
    revision: number,
    policies: Array<ToolPolicy>,
  ) {
    policies.forEach(validateToolPolicy)
    await this.transaction(async (database) => {
      const result = await database.query(
        'UPDATE mcp_connections SET revision=revision+1,updated_at=now() WHERE id=$1 AND revision=$2',
        [id, revision],
      )
      if (result.rowCount !== 1)
        throw new RevisionConflictError('Connection changed; reload and retry')
      await database.query('DELETE FROM tool_policies WHERE connection_id=$1', [
        id,
      ])
      for (const policy of policies)
        await database.query(
          'INSERT INTO tool_policies(id,connection_id,pattern,annotation,effect) VALUES($1,$2,$3,$4,$5)',
          [
            randomUUID(),
            id,
            policy.pattern ?? null,
            policy.annotation ?? null,
            policy.effect,
          ],
        )
    })
    return { revision: revision + 1 }
  }
  private readonly clients = new Map<string, Promise<UpstreamClient>>()
  readonly oauth: UpstreamOAuth

  constructor(
    private readonly pool: Pool,
    private readonly vault: SecretVault,
    private readonly connect: Connect = McpUpstreamClient.connect,
  ) {
    this.oauth = new UpstreamOAuth(pool, vault)
  }

  async create(input: ConnectionInput) {
    validateInput(input)
    const discovery = await this.discoverForSave(input.transport)
    const id = randomUUID()
    const namespace = input.namespace ?? namespaceOf(input.displayName)
    await this.transaction(async (database) => {
      await database.query(
        `INSERT INTO mcp_connections
          (id, organization_id, display_name, namespace, transport,
           transport_config, state, registry_source_id, registry_server_id, registry_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          id,
          input.organizationId,
          input.displayName,
          namespace,
          input.transport.kind,
          input.transport,
          input.state,
          input.registry?.sourceId ?? null,
          input.registry?.serverId ?? null,
          input.registry?.version ?? null,
        ],
      )
      await this.replaceChildren(database, id, input, discovery.tools)
      if (discovery.error)
        await this.recordHealth(database, id, false, discovery.error)
    })
    return { id, namespace, revision: 1, tools: discovery.tools }
  }

  async edit(
    id: string,
    expectedRevision: number,
    input: ConnectionInput,
    userId?: string,
  ) {
    validateInput(input)
    const discovery = await this.discover(
      id,
      input.transport,
      userId,
      input.state === 'disabled',
    )
    await this.transaction(async (database) => {
      const result = await database.query(
        `UPDATE mcp_connections SET display_name=$1, transport=$2,
          transport_config=$3, state=$4, revision=revision+1, updated_at=now(),
          registry_source_id=$5, registry_server_id=$6, registry_version=$7
         WHERE id=$8 AND revision=$9`,
        [
          input.displayName,
          input.transport.kind,
          input.transport,
          input.state,
          input.registry?.sourceId ?? null,
          input.registry?.serverId ?? null,
          input.registry?.version ?? null,
          id,
          expectedRevision,
        ],
      )
      if (result.rowCount !== 1)
        throw new RevisionConflictError('Connection changed; reload and retry')
      await this.replaceChildren(database, id, input, discovery.tools)
      if (discovery.error)
        await this.recordHealth(database, id, false, discovery.error)
    })
    await this.restartConnection(id)
    return { id, revision: expectedRevision + 1, tools: discovery.tools }
  }

  async clone(id: string, displayName: string, namespace?: string) {
    const result = await this.pool.query(
      `SELECT organization_id, transport_config FROM mcp_connections WHERE id=$1`,
      [id],
    )
    const source = result.rows[0]
    if (!source) throw new Error('Connection not found')
    const groups = await this.pool.query(
      'SELECT group_id FROM connection_groups WHERE connection_id=$1',
      [id],
    )
    const policies = await this.pool.query(
      'SELECT pattern, annotation, effect FROM tool_policies WHERE connection_id=$1',
      [id],
    )
    return this.create({
      organizationId: source.organization_id as string,
      displayName,
      ...(namespace ? { namespace } : {}),
      transport: source.transport_config as TransportConfig,
      state: 'enabled',
      groupIds: groups.rows.map((row) => row.group_id as string),
      policies: policies.rows.map(policyFromRow),
    })
  }

  async setEnabled(id: string, enabled: boolean) {
    const result = await this.pool.query(
      `UPDATE mcp_connections SET state=$1, revision=revision+1, updated_at=now()
       WHERE id=$2 RETURNING revision`,
      [enabled ? 'enabled' : 'disabled', id],
    )
    if (!result.rows[0]) throw new Error('Connection not found')
    await this.restartConnection(id)
    return result.rows[0].revision as number
  }

  async addAccount(input: {
    connectionId: string
    kind: 'shared' | 'personal'
    ownerUserId?: string
    displayName: string
    secrets?: Record<string, string>
  }): Promise<AccountSummary> {
    if ((input.kind === 'personal') !== Boolean(input.ownerUserId))
      throw new Error('Personal Accounts require exactly one owner')
    const connection = await this.pool.query(
      'SELECT namespace FROM mcp_connections WHERE id=$1',
      [input.connectionId],
    )
    if (!connection.rows[0]) throw new Error('Connection not found')
    const namespace = `${connection.rows[0].namespace}_${namespaceOf(input.displayName)}`
    // Give a useful save error; database claims also protect concurrent writes.
    const conflict = await this.pool.query(
      `SELECT 1 FROM mcp_accounts WHERE namespace=$1
       AND (kind <> $2 OR kind='shared' OR owner_user_id=$3) LIMIT 1`,
      [namespace, input.kind, input.ownerUserId ?? null],
    )
    if (conflict.rowCount)
      throw new Error(
        'Account namespace is already in use; choose a different account name',
      )
    const envelope = input.secrets
      ? await this.vault.seal(input.secrets)
      : undefined
    const id = randomUUID()
    await this.pool.query(
      `INSERT INTO mcp_accounts
       (id, connection_id, kind, owner_user_id, display_name, namespace,
        secret_ciphertext, secret_nonce, secret_format_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        id,
        input.connectionId,
        input.kind,
        input.ownerUserId ?? null,
        input.displayName,
        namespace,
        envelope?.ciphertext ?? null,
        envelope?.nonce ?? null,
        envelope?.version ?? null,
      ],
    )
    return {
      id,
      connectionId: input.connectionId,
      kind: input.kind,
      ...(input.ownerUserId ? { ownerUserId: input.ownerUserId } : {}),
      displayName: input.displayName,
      namespace,
      hasSecret: Boolean(envelope),
    }
  }

  async visibleAccounts(connectionId: string, userId: string) {
    const result = await this.pool.query(
      `SELECT id, connection_id, kind, owner_user_id, display_name, namespace,
              secret_ciphertext IS NOT NULL AS has_secret
       FROM mcp_accounts
       WHERE connection_id=$1 AND (kind='shared' OR owner_user_id=$2)
       ORDER BY display_name`,
      [connectionId, userId],
    )
    return result.rows.map(accountSummary)
  }

  async refreshConnection(id: string, userId?: string) {
    const result = await this.pool.query(
      'SELECT transport_config FROM mcp_connections WHERE id=$1',
      [id],
    )
    if (!result.rows[0]) throw new Error('Connection not found')
    await this.refresh(
      id,
      result.rows[0].transport_config as TransportConfig,
      userId,
    )
  }

  async configureOAuth(
    connectionId: string,
    config: OAuthClientConfig | undefined,
  ) {
    await this.oauth.configureConnection(connectionId, config)
    await this.restartConnection(connectionId)
  }

  startOAuth(accountId: string, principalId: string) {
    return this.oauth.start(accountId, principalId)
  }

  async finishOAuth(state: string, code: string) {
    const completed = await this.oauth.finish(state, code)
    await this.restartConnection(completed.connectionId)
    return completed
  }

  async replaceAccountSecrets(id: string, secrets: Record<string, string>) {
    const envelope = await this.vault.seal(secrets)
    const result = await this.pool.query(
      `UPDATE mcp_accounts SET secret_ciphertext=$1, secret_nonce=$2,
       secret_format_version=$3, updated_at=now() WHERE id=$4
       RETURNING connection_id`,
      [envelope.ciphertext, envelope.nonce, envelope.version, id],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Account not found')
    await this.restartConnection(row.connection_id as string)
  }

  async clearAccountSecrets(id: string) {
    const result = await this.pool.query(
      `UPDATE mcp_accounts SET secret_ciphertext=null, secret_nonce=null,
       secret_format_version=null, updated_at=now() WHERE id=$1
       RETURNING connection_id`,
      [id],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Account not found')
    await this.restartConnection(row.connection_id as string)
  }

  async deleteAccount(id: string) {
    const result = await this.pool.query(
      'DELETE FROM mcp_accounts WHERE id=$1 RETURNING connection_id',
      [id],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Account not found')
    await this.restartConnection(row.connection_id as string)
  }

  async callAccountTool(
    connectionId: string,
    accountId: string | undefined,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) {
    const key = `${connectionId}:${accountId ?? 'accountless'}`
    let client = this.clients.get(key)
    if (!client) {
      client = this.openClient(connectionId, accountId)
      this.clients.set(key, client)
      client.catch(() => this.clients.delete(key))
    }
    return withTimeout(
      (timeoutSignal) =>
        client.then((upstream) =>
          upstream.callTool(
            toolName,
            args,
            combineSignals(signal, timeoutSignal),
          ),
        ),
      signal,
    )
  }

  async refreshDue(now = new Date()) {
    const result = await this.pool.query(
      `SELECT id, transport_config FROM mcp_connections c
       LEFT JOIN connection_health h ON h.connection_id=c.id
       WHERE c.state='enabled' AND
         (h.checked_at IS NULL OR h.checked_at < $1::timestamptz - interval '6 hours')`,
      [now],
    )
    await Promise.allSettled(
      result.rows.map((row) =>
        this.refresh(row.id as string, row.transport_config as TransportConfig),
      ),
    )
  }

  async close() {
    const clients = [...this.clients.values()]
    this.clients.clear()
    await Promise.allSettled(
      clients.map(async (client) => (await client).close()),
    )
  }

  private async probe(config: TransportConfig) {
    const client = await this.connect(config, {})
    try {
      return await withTimeout((signal) => client.listTools(signal))
    } finally {
      await client.close()
    }
  }

  private async probeAccount(
    connectionId: string,
    config: TransportConfig,
    accountId: string,
  ) {
    const result = await this.pool.query(
      `SELECT a.secret_ciphertext, a.secret_nonce, a.secret_format_version,
              c.oauth_client_ciphertext IS NOT NULL AS has_oauth
       FROM mcp_accounts a JOIN mcp_connections c ON c.id=a.connection_id
       WHERE a.id=$1 AND a.connection_id=$2`,
      [accountId, connectionId],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Account not found')
    let secrets: Record<string, string> = {}
    if (row.secret_ciphertext)
      secrets = await this.vault.open({
        ciphertext: new Uint8Array(row.secret_ciphertext),
        nonce: new Uint8Array(row.secret_nonce),
        version: row.secret_format_version as number,
      })
    const hasOAuth = Boolean(row.has_oauth || secrets.oauthTokens)
    delete secrets.oauthTokens
    delete secrets.oauthClient
    const provider = hasOAuth ? await this.oauth.provider(accountId) : undefined
    const client = await this.connect(config, secrets, provider)
    try {
      return await withTimeout((signal) => client.listTools(signal))
    } finally {
      await client.close()
    }
  }

  private async discover(
    connectionId: string,
    config: TransportConfig,
    userId?: string,
    allowFailure = false,
  ): Promise<{ tools: Array<DiscoveredTool>; error?: string }> {
    const accounts = await this.pool.query(
      `SELECT id FROM mcp_accounts
       WHERE connection_id=$1 AND secret_ciphertext IS NOT NULL
         AND (kind='shared' OR (kind='personal' AND owner_user_id=$2))
       ORDER BY CASE kind WHEN 'shared' THEN 0 ELSE 1 END, display_name, id`,
      [connectionId, userId ?? null],
    )
    const attempts: Array<() => Promise<Array<DiscoveredTool>>> = [
      ...accounts.rows.map(
        (row) => () =>
          this.probeAccount(connectionId, config, row.id as string),
      ),
      () => this.probe(config),
    ]
    let firstError: unknown
    for (const attempt of attempts)
      try {
        return { tools: await attempt() }
      } catch (error) {
        // Keep the preferred Account's failure instead of hiding it behind
        // the final anonymous probe's inevitable authentication error.
        firstError ??= error
      }
    const message =
      firstError instanceof Error ? firstError.message : 'Tool discovery failed'
    if (!allowFailure) throw new Error(message)
    return { tools: [], error: message }
  }

  private async discoverForSave(config: TransportConfig) {
    try {
      return { tools: await this.probe(config) }
    } catch (error) {
      // Accounts can only be added after the connection has been saved.
      return {
        tools: [],
        error: error instanceof Error ? error.message : 'Tool discovery failed',
      }
    }
  }

  private async openClient(connectionId: string, accountId?: string) {
    const result = await this.pool.query(
      `SELECT c.transport_config, c.state,
              c.oauth_client_ciphertext IS NOT NULL AS has_oauth,
              a.secret_ciphertext, a.secret_nonce, a.secret_format_version
       FROM mcp_connections c
       LEFT JOIN mcp_accounts a ON a.id=$2 AND a.connection_id=c.id
       WHERE c.id=$1`,
      [connectionId, accountId ?? null],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Connection or Account not found')
    if (row.state !== 'enabled') throw new Error('Connection is disabled')
    let secrets: Record<string, string> = {}
    if (row.secret_ciphertext) {
      secrets = await this.vault.open({
        ciphertext: new Uint8Array(row.secret_ciphertext),
        nonce: new Uint8Array(row.secret_nonce),
        version: row.secret_format_version as number,
      })
    }
    const hasOAuth = Boolean(row.has_oauth || secrets.oauthTokens)
    delete secrets.oauthTokens
    delete secrets.oauthClient
    const provider =
      hasOAuth && accountId ? await this.oauth.provider(accountId) : undefined
    return this.connect(
      row.transport_config as TransportConfig,
      secrets,
      provider,
    )
  }

  private async refresh(id: string, config: TransportConfig, userId?: string) {
    try {
      const { tools } = await this.discover(id, config, userId)
      await this.transaction(async (database) => {
        await database.query(
          'DELETE FROM connection_tools WHERE connection_id=$1',
          [id],
        )
        await insertTools(database, id, tools)
        await database.query(
          `INSERT INTO connection_health (connection_id, healthy, error)
           VALUES ($1,true,null) ON CONFLICT (connection_id) DO UPDATE
           SET checked_at=now(), healthy=true, error=null`,
          [id],
        )
      })
    } catch (error) {
      await this.pool.query(
        `INSERT INTO connection_health (connection_id, healthy, error)
         VALUES ($1,false,$2) ON CONFLICT (connection_id) DO UPDATE
         SET checked_at=now(), healthy=false, error=$2`,
        [id, error instanceof Error ? error.message : 'Unknown error'],
      )
      throw error
    }
  }

  private async recordHealth(
    database: PoolClient,
    id: string,
    healthy: boolean,
    error: string | null,
  ) {
    await database.query(
      `INSERT INTO connection_health (connection_id, healthy, error)
       VALUES ($1,$2,$3) ON CONFLICT (connection_id) DO UPDATE
       SET checked_at=now(), healthy=$2, error=$3`,
      [id, healthy, error],
    )
  }

  private async replaceChildren(
    database: PoolClient,
    id: string,
    input: ConnectionInput,
    tools: Array<DiscoveredTool>,
  ) {
    await database.query(
      'DELETE FROM connection_groups WHERE connection_id=$1',
      [id],
    )
    await database.query('DELETE FROM tool_policies WHERE connection_id=$1', [
      id,
    ])
    await database.query(
      'DELETE FROM connection_tools WHERE connection_id=$1',
      [id],
    )
    for (const groupId of input.groupIds)
      await database.query(
        'INSERT INTO connection_groups (connection_id, group_id) VALUES ($1,$2)',
        [id, groupId],
      )
    for (const policy of input.policies)
      await database.query(
        `INSERT INTO tool_policies (id, connection_id, pattern, annotation, effect)
         VALUES ($1,$2,$3,$4,$5)`,
        [
          randomUUID(),
          id,
          policy.pattern ?? null,
          policy.annotation ?? null,
          policy.effect,
        ],
      )
    await insertTools(database, id, tools)
    await database.query(
      `INSERT INTO connection_health (connection_id, healthy, error)
       VALUES ($1,true,null) ON CONFLICT (connection_id) DO UPDATE
       SET checked_at=now(), healthy=true, error=null`,
      [id],
    )
  }

  private async restartConnection(connectionId: string) {
    const matching = [...this.clients.entries()].filter(([key]) =>
      key.startsWith(`${connectionId}:`),
    )
    for (const [key, client] of matching) {
      this.clients.delete(key)
      await (await client).close()
    }
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const result = await work(client)
      await client.query('COMMIT')
      return result
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }
}

function validateInput(input: ConnectionInput) {
  if (!input.displayName.trim()) throw new Error('Display name is required')
  if (input.namespace) validateNamespace(input.namespace)
  if (input.transport.kind === 'streamable_http')
    validateHttpUrl(input.transport.url)
  if (input.transport.kind === 'streamable_http')
    for (const name of Object.keys(input.transport.headers ?? {}))
      validateHeaderName(name)
  input.policies.forEach(validateToolPolicy)
}

function validateHeaderName(name: string) {
  const reserved = new Set([
    'connection',
    'content-length',
    'host',
    'mcp-protocol-version',
    'mcp-session-id',
    'proxy-authorization',
    'te',
    'trailer',
    'transfer-encoding',
    'upgrade',
  ])
  if (reserved.has(name.toLowerCase()))
    throw new Error(`Header ${name} is managed by the gateway`)
}

function namespaceOf(value: string) {
  const namespace = deriveNamespace(value)
  validateNamespace(namespace)
  return namespace
}

function validateNamespace(value: string) {
  if (!/^[a-z][a-z0-9_]*$/.test(value))
    throw new Error(
      'Namespace must start with a letter and contain letters, numbers, or underscores',
    )
}

async function insertTools(
  database: PoolClient,
  id: string,
  tools: Array<DiscoveredTool>,
) {
  for (const tool of tools)
    await database.query(
      `INSERT INTO connection_tools
       (connection_id, name, description, input_schema, output_schema, annotations)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        id,
        tool.name,
        tool.description ?? null,
        tool.inputSchema,
        tool.outputSchema ?? null,
        tool.annotations ?? null,
      ],
    )
}

function accountSummary(row: Record<string, unknown>): AccountSummary {
  return {
    id: row.id as string,
    connectionId: row.connection_id as string,
    kind: row.kind as 'shared' | 'personal',
    ...(row.owner_user_id ? { ownerUserId: row.owner_user_id as string } : {}),
    displayName: row.display_name as string,
    namespace: row.namespace as string,
    hasSecret: row.has_secret as boolean,
  }
}

async function withTimeout<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal,
) {
  const controller = new AbortController()
  const abort = () => controller.abort(parent?.reason)
  parent?.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(() => controller.abort(), 60_000)
  try {
    return await work(controller.signal)
  } finally {
    clearTimeout(timeout)
    parent?.removeEventListener('abort', abort)
  }
}

function combineSignals(left: AbortSignal | undefined, right: AbortSignal) {
  return left ? AbortSignal.any([left, right]) : right
}
