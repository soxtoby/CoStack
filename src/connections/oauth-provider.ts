import {
  discoverOAuthServerInfo,
  refreshAuthorization,
  selectResourceURL,
} from '@modelcontextprotocol/sdk/client/auth.js'
import {
  InvalidClientError,
  InvalidGrantError,
  UnauthorizedClientError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js'
import { checkResourceAllowed } from '@modelcontextprotocol/sdk/shared/auth-utils.js'
import { asError, logger } from '../server/logging'
import {
  UpstreamAuthorizationRequiredError,
  clearAuthorizationFailure,
  recordAuthorizationFailure,
} from './authorization-failure'
import { envelopeFrom, toStrings } from './secrets'
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
import type { SecretVault } from './secrets'
import type { OAuthClientConfig } from './types'

/** Tokens this close to expiry are refreshed before use instead of waiting for a 401. */
const refreshMargin = 60 * 1000
/** One refresh per Account at a time; a second concurrent use of a refresh token is what upstreams reject. */
const refreshes = new Map<string, Promise<OAuthTokens | undefined>>()
/** Account secrets that hold OAuth state rather than credentials to forward upstream. */
const oauthSecretNames = ['oauthTokens', 'oauthClient', 'oauthExpiresAt']

export type StoredAuthorization = {
  client?: string
  verifier?: string
  tokens?: string
  discovery?: string
}

type StoredAccount = {
  secrets: Record<string, string>
  failure?: string
}

export type OAuthContext = {
  accountId: string
  displayName: string
  connectionId: string
  serverUrl: string
  client: OAuthClientConfig | undefined
}

/** The credentials to forward upstream, without the OAuth state stored alongside them. */
export function withoutOAuthState(secrets: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(secrets).filter(
      ([name]) => !oauthSecretNames.includes(name),
    ),
  )
}

export class DatabaseOAuthProvider implements OAuthClientProvider {
  authorizationUrl?: URL
  /** The serialized tokens most recently handed to a caller, to tell a stale rejection from a fresh one. */
  private issuedTokens: string | undefined
  private refreshing = false

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
      token_endpoint_auth_method: this.context.client?.clientSecret
        ? 'client_secret_basic'
        : 'none',
      ...(this.context.client?.scope
        ? { scope: this.context.client.scope }
        : {}),
    }
  }

  state() {
    return this.flowState
  }
  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    if (this.context.client)
      return {
        client_id: this.context.client.clientId,
        client_secret: this.context.client.clientSecret,
      }
    const client =
      this.flow.client ?? (await this.account()).secrets.oauthClient
    return client
      ? (JSON.parse(client) as OAuthClientInformationMixed)
      : undefined
  }
  async saveClientInformation(client: OAuthClientInformationMixed) {
    this.flow.client = JSON.stringify(client)
    if (this.flowState) await this.saveFlow()
  }
  /** A recorded failure hides the tokens so the SDK asks for authorization instead of retrying a dead refresh token. */
  async tokens(): Promise<OAuthTokens | undefined> {
    const account = await this.account()
    this.issuedTokens = account.secrets.oauthTokens
    const tokens = account.failure
      ? undefined
      : parseTokens(account.secrets.oauthTokens)

    if (
      tokens?.refresh_token &&
      !this.refreshing &&
      expiresSoon(account.secrets.oauthExpiresAt)
    )
      return this.refreshAhead()
    else return tokens
  }
  async saveTokens(tokens: OAuthTokens) {
    const stored = (await this.account()).secrets
    stored.oauthTokens = JSON.stringify(tokens)
    if (tokens.expires_in === undefined) delete stored.oauthExpiresAt
    else stored.oauthExpiresAt = String(Date.now() + tokens.expires_in * 1000)
    if (this.flow.client) stored.oauthClient = this.flow.client

    await this.saveAccountSecrets(stored)
    await clearAuthorizationFailure(this.pool, this.context.accountId)
    this.issuedTokens = stored.oauthTokens
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url
  }
  async saveCodeVerifier(verifier: string) {
    // Only an interactive flow can send a person to the authorization page.
    if (!this.flowState) throw await this.authorizationRequired()
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
  validateResourceURL(serverUrl: string | URL, resource?: string) {
    if (!resource) return Promise.resolve(undefined)
    if (
      !checkResourceAllowed({
        requestedResource: serverUrl,
        configuredResource: resource,
      })
    )
      throw new Error(
        `Protected resource ${resource} does not match ${serverUrl}`,
      )
    const selected = new URL(resource)
    // Azure DevOps advertises an organization URL, but Entra selects its
    // service-wide audience through the fully qualified scope.
    return Promise.resolve(
      selected.origin === 'https://mcp.dev.azure.com' ? undefined : selected,
    )
  }
  async invalidateCredentials(
    scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery',
  ) {
    if (scope === 'client' || scope === 'all') {
      delete this.flow.client
      const stored = (await this.account()).secrets
      delete stored.oauthClient
      await this.saveAccountSecrets(stored)
    }
    if (scope === 'tokens' || scope === 'all')
      await this.rejectTokens(
        scope === 'all'
          ? 'The upstream server no longer recognizes the OAuth client'
          : 'The upstream server rejected the refresh token',
      )
    if (scope === 'verifier' || scope === 'all') delete this.flow.verifier
    if (scope === 'discovery' || scope === 'all') delete this.flow.discovery
  }

  private refreshAhead() {
    const key = this.context.accountId
    let pending = refreshes.get(key)
    if (!pending) {
      pending = this.refreshNow().finally(() => refreshes.delete(key))
      refreshes.set(key, pending)
    }
    return pending
  }

  private async refreshNow(): Promise<OAuthTokens | undefined> {
    this.refreshing = true
    try {
      const serverUrl = this.context.serverUrl
      const current = (await this.account()).secrets.oauthTokens
      this.issuedTokens = current
      const refreshToken = parseTokens(current)?.refresh_token
      const client = await this.clientInformation()
      if (!refreshToken || !client) throw await this.authorizationRequired()

      const server = await discoverOAuthServerInfo(serverUrl)
      const resource = await selectResourceURL(
        serverUrl,
        this,
        server.resourceMetadata,
      )

      const refreshed = await refreshAuthorization(
        server.authorizationServerUrl,
        {
          ...(server.authorizationServerMetadata
            ? { metadata: server.authorizationServerMetadata }
            : {}),
          clientInformation: client,
          refreshToken,
          ...(resource ? { resource } : {}),
        },
      )

      await this.saveTokens(refreshed)
      return refreshed
    } catch (error) {
      return this.recoverRefresh(error)
    } finally {
      this.refreshing = false
    }
  }

  /** Only a definite rejection by the upstream marks the Account; anything else keeps the current token for the 401 path. */
  private async recoverRefresh(
    error: unknown,
  ): Promise<OAuthTokens | undefined> {
    if (error instanceof UpstreamAuthorizationRequiredError) throw error
    if (error instanceof InvalidGrantError) {
      await this.rejectTokens(
        ['The upstream server rejected the refresh token', error.message]
          .filter(Boolean)
          .join(': '),
      )
      throw await this.authorizationRequired()
    } else if (
      error instanceof InvalidClientError ||
      error instanceof UnauthorizedClientError
    ) {
      await this.invalidateCredentials('all')
      throw await this.authorizationRequired()
    } else {
      logger.warn(
        asError(error),
        'Could not refresh the token for Account {AccountId} ahead of expiry; continuing with the current token',
        { AccountId: this.context.accountId },
      )
      return parseTokens((await this.account()).secrets.oauthTokens)
    }
  }

  /**
   * Tokens stay stored so the Account keeps its OAuth provider and reports a
   * clear failure; a rejection of tokens another call has already replaced is
   * stale and ignored.
   */
  private async rejectTokens(reason: string) {
    const current = (await this.account()).secrets.oauthTokens
    if (current && current === this.issuedTokens)
      await recordAuthorizationFailure(
        this.pool,
        this.context.accountId,
        reason,
      )
  }

  private async authorizationRequired() {
    const failure = (await this.account()).failure
    return new UpstreamAuthorizationRequiredError(
      `Account "${this.context.displayName}" needs to be re-authorized in CoStack${failure ? `: ${failure}` : ''}`,
    )
  }

  private async account(): Promise<StoredAccount> {
    const result = await this.pool.query(
      `SELECT secret_ciphertext, secret_nonce, secret_format_version, authorization_error
       FROM mcp_accounts WHERE id=$1`,
      [this.context.accountId],
    )
    const row = result.rows[0]
    if (!row) throw new Error('Account not found')
    return {
      secrets: row.secret_ciphertext
        ? await this.vault.open(envelopeFrom(row))
        : {},
      ...(row.authorization_error
        ? { failure: row.authorization_error as string }
        : {}),
    }
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

function parseTokens(value: string | undefined) {
  return value ? (JSON.parse(value) as OAuthTokens) : undefined
}

function expiresSoon(value: string | undefined) {
  return value !== undefined && Number(value) - Date.now() < refreshMargin
}
