import { randomUUID } from 'node:crypto'
import { auth } from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientProvider,
  OAuthDiscoveryState,
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js'
import type { Pool } from 'pg'
import type { SecretEnvelope, SecretVault } from './secrets'
import type { OAuthClientConfig } from './types'

const FLOW_LIFETIME_MS = 10 * 60 * 1000

type StoredAuthorization = {
  verifier?: string
  tokens?: string
  discovery?: string
}

export class UpstreamOAuth {
  constructor(
    private readonly pool: Pool,
    private readonly vault: SecretVault,
    private readonly applicationUrl = process.env.APPLICATION_URL,
  ) {}

  async configureConnection(
    connectionId: string,
    config: OAuthClientConfig | undefined,
  ) {
    const envelope = config
      ? await this.vault.seal(toStrings(config))
      : undefined
    const result = await this.pool.query(
      `UPDATE mcp_connections SET oauth_client_ciphertext=$1,
       oauth_client_nonce=$2, oauth_client_format_version=$3,
       revision=revision+1, updated_at=now() WHERE id=$4`,
      [
        envelope?.ciphertext ?? null,
        envelope?.nonce ?? null,
        envelope?.version ?? null,
        connectionId,
      ],
    )
    if (result.rowCount !== 1) throw new Error('Connection not found')
  }

  async start(accountId: string, principalId: string) {
    const context = await this.context(accountId, principalId)
    const state = randomUUID()
    const envelope = await this.vault.seal({})
    await this.pool.query(
      `INSERT INTO upstream_oauth_flows
       (state, connection_id, account_id, principal_id, secret_ciphertext,
        secret_nonce, secret_format_version, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        state,
        context.connectionId,
        accountId,
        principalId,
        envelope.ciphertext,
        envelope.nonce,
        envelope.version,
        new Date(Date.now() + FLOW_LIFETIME_MS),
      ],
    )
    const provider = new DatabaseOAuthProvider(
      this.pool,
      this.vault,
      context,
      this.callbackUrl(),
      state,
    )
    const result = await auth(provider, {
      serverUrl: context.serverUrl,
      ...(context.client.scope ? { scope: context.client.scope } : {}),
    })
    if (result !== 'REDIRECT' || !provider.authorizationUrl)
      throw new Error('Upstream did not start interactive authorization')
    return { authorizationUrl: provider.authorizationUrl.toString() }
  }

  async finish(state: string, code: string) {
    const flow = await this.pool.query(
      `DELETE FROM upstream_oauth_flows WHERE state=$1 AND expires_at>now()
       RETURNING connection_id, account_id, principal_id, secret_ciphertext,
                 secret_nonce, secret_format_version`,
      [state],
    )
    const row = flow.rows[0]
    if (!row) throw new Error('Authorization state is invalid or expired')
    const context = await this.context(
      row.account_id as string,
      row.principal_id as string,
    )
    const provider = new DatabaseOAuthProvider(
      this.pool,
      this.vault,
      context,
      this.callbackUrl(),
      '',
      await this.open(row),
    )
    const result = await auth(provider, {
      serverUrl: context.serverUrl,
      authorizationCode: code,
      ...(context.client.scope ? { scope: context.client.scope } : {}),
    })
    if (result !== 'AUTHORIZED')
      throw new Error('Authorization did not complete')
    return { accountId: context.accountId, connectionId: context.connectionId }
  }

  async provider(accountId: string) {
    const context = await this.context(accountId)
    return new DatabaseOAuthProvider(
      this.pool,
      this.vault,
      context,
      this.callbackUrl(),
      '',
    )
  }

  private callbackUrl() {
    if (!this.applicationUrl)
      throw new Error('APPLICATION_URL is required for upstream OAuth')
    return new URL(
      '/api/upstream-oauth/callback',
      this.applicationUrl,
    ).toString()
  }

  private async context(
    accountId: string,
    principalId?: string,
  ): Promise<OAuthContext> {
    const result = await this.pool.query(
      `SELECT a.id account_id, a.kind, a.owner_user_id, c.id connection_id,
              c.transport_config, c.oauth_client_ciphertext,
              c.oauth_client_nonce, c.oauth_client_format_version,
              EXISTS (
                SELECT 1 FROM group_memberships gm
                JOIN group_capabilities gc ON gc.group_id=gm.group_id
                WHERE gm.principal_id=$2 AND gc.capability_name='manage_accounts'
              ) can_manage
       FROM mcp_accounts a JOIN mcp_connections c ON c.id=a.connection_id
       WHERE a.id=$1`,
      [accountId, principalId ?? null],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Account not found')
    if (
      principalId &&
      row.kind === 'personal' &&
      row.owner_user_id !== principalId
    )
      throw new Error('Personal Account belongs to another User')
    if (principalId && row.kind === 'shared' && !row.can_manage)
      throw new Error('Shared Account authorization requires manage_accounts')
    if (!row.oauth_client_ciphertext)
      throw new Error('Connection OAuth client is not configured')
    const transport = row.transport_config as { kind: string; url?: string }
    if (transport.kind !== 'streamable_http' || !transport.url)
      throw new Error('OAuth requires a Streamable HTTP Connection')
    const client = fromStrings(
      await this.vault.open(envelopeFrom(row)),
    ) as OAuthClientConfig
    return {
      accountId,
      connectionId: row.connection_id as string,
      serverUrl: transport.url,
      client,
    }
  }

  private open(row: Record<string, unknown>) {
    return this.vault.open(envelopeFrom(row)) as Promise<StoredAuthorization>
  }
}

type OAuthContext = {
  accountId: string
  connectionId: string
  serverUrl: string
  client: OAuthClientConfig
}

class DatabaseOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL

  constructor(
    private readonly pool: Pool,
    private readonly vault: SecretVault,
    private readonly context: OAuthContext,
    readonly redirectUrl: string,
    private readonly flowState: string,
    private flow: StoredAuthorization = {},
  ) {}

  get clientMetadata(): OAuthClientMetadata {
    return {
      redirect_uris: [this.redirectUrl],
      client_name: 'CoStack',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_basic',
      ...(this.context.client.scope
        ? { scope: this.context.client.scope }
        : {}),
    }
  }

  state() {
    return this.flowState
  }
  clientInformation(): OAuthClientInformationMixed {
    return {
      client_id: this.context.client.clientId,
      client_secret: this.context.client.clientSecret,
    }
  }
  async tokens() {
    const stored = await this.accountSecrets()
    return stored.oauthTokens
      ? (JSON.parse(stored.oauthTokens) as OAuthTokens)
      : undefined
  }
  async saveTokens(tokens: OAuthTokens) {
    const stored = await this.accountSecrets()
    stored.oauthTokens = JSON.stringify(tokens)
    await this.saveAccountSecrets(stored)
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  async saveCodeVerifier(verifier: string) {
    this.flow.verifier = verifier
    await this.saveFlow()
  }
  codeVerifier() {
    if (!this.flow.verifier) throw new Error('OAuth code verifier is missing')
    return this.flow.verifier
  }
  async saveDiscoveryState(discovery: OAuthDiscoveryState) {
    this.flow.discovery = JSON.stringify(discovery)
    if (this.flowState) await this.saveFlow()
  }
  discoveryState() {
    return this.flow.discovery
      ? (JSON.parse(this.flow.discovery) as OAuthDiscoveryState)
      : undefined
  }
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ) {
    if (scope === 'tokens' || scope === 'all') {
      const stored = await this.accountSecrets()
      delete stored.oauthTokens
      await this.saveAccountSecrets(stored)
    }
    if (scope === 'verifier' || scope === 'all') delete this.flow.verifier
    if (scope === 'discovery' || scope === 'all') delete this.flow.discovery
  }

  private async accountSecrets(): Promise<Record<string, string>> {
    const result = await this.pool.query(
      `SELECT secret_ciphertext, secret_nonce, secret_format_version
       FROM mcp_accounts WHERE id=$1`,
      [this.context.accountId],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Account not found')
    return row.secret_ciphertext
      ? this.vault.open(envelopeFrom(row))
      : Promise.resolve({})
  }

  private async saveAccountSecrets(value: Record<string, string>) {
    const envelope = await this.vault.seal(value)
    await this.pool.query(
      `UPDATE mcp_accounts SET secret_ciphertext=$1, secret_nonce=$2,
       secret_format_version=$3, updated_at=now() WHERE id=$4`,
      [
        envelope.ciphertext,
        envelope.nonce,
        envelope.version,
        this.context.accountId,
      ],
    )
  }

  private async saveFlow() {
    const envelope = await this.vault.seal(toStrings(this.flow))
    const result = await this.pool.query(
      `UPDATE upstream_oauth_flows SET secret_ciphertext=$1, secret_nonce=$2,
       secret_format_version=$3 WHERE state=$4 AND expires_at>now()`,
      [envelope.ciphertext, envelope.nonce, envelope.version, this.flowState],
    )
    if (result.rowCount !== 1)
      throw new Error('Authorization state is invalid or expired')
  }
}

function envelopeFrom(row: Record<string, unknown>): SecretEnvelope {
  const prefix = row.oauth_client_ciphertext
    ? 'oauth_client_'
    : row.secret_ciphertext
      ? 'secret_'
      : ''
  return {
    ciphertext: new Uint8Array(row[`${prefix}ciphertext`] as Uint8Array),
    nonce: new Uint8Array(row[`${prefix}nonce`] as Uint8Array),
    version: row[`${prefix}format_version`] as number,
  }
}

function toStrings(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => [k, String(v)]),
  )
}

function fromStrings(value: Record<string, string>) {
  return value
}
