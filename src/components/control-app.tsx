import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useSearch,
} from '@tanstack/react-router'
import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { ToolPolicyEditor } from '../components/tool-policy-editor'
import { defaultToolPolicies, validateToolPolicy } from '../connections/policy'
import { deriveNamespace } from '../connections/namespace'
import { rankRegistryServers } from '../connections/registry-ranking'
import {
  formatStdioCommandLine,
  parseStdioCommandLine,
} from '../connections/stdio'
import {
  bundledPrefill,
  findBundledMcp,
  isBundledRegistryEntry,
  resolveBundledTransport,
  searchBundledMcps,
  tenantIdPattern,
} from '../connections/bundled-mcps'
import { BundledMcpCards, BundledMcpSetup } from './bundled-mcps'
import { McpIcon } from './mcp-icon'
import { BrandIcon } from './brand-icon'
import { UiIcon } from './ui-icon'
import { responseError } from './response-error'
import type { FormEvent, ReactNode } from 'react'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type { BundledMcp } from '../connections/bundled-mcps'
import type {
  ConnectionInput,
  OAuthClientSummary,
  ToolPolicy,
} from '../connections/types'
import type { RegistryServer } from '../connections/registry'
import type { AccessDeniedReason } from '../auth/access-denied'

const pagePaths = {
  connections: '/connections',
  preferences: '/preferences',
  audit: '/audit',
  users: '/users',
  groups: '/groups',
  services: '/service-accounts',
} as const
type Group = {
  id: string
  display_name: string
  is_administrators: boolean
  capabilities: Array<string>
}
type Principal = {
  id: string
  display_name: string
  email?: string
  disabled_at: string | null
  group_ids: Array<string>
  oauth_client_id?: string
}
type Data = {
  state: 'bootstrap' | 'login' | 'ready' | 'forbidden'
  reason?: AccessDeniedReason
  accessEmail?: string
  loginProviderId?: string
  me?: { name: string; email: string }
  organization?: { display_name: string }
  authorization?: { administrator: boolean; capabilities: Array<string> }
  users?: Array<Principal>
  groups?: Array<Group>
  access?: Array<{
    id: string
    normalized_email: string
    expires_at: string
    claimed_at: string | null
    revoked_at: string | null
    group_ids: Array<string>
  }>
  serviceAccounts?: Array<Principal>
  providers?: Array<{
    provider_id: string
    domain: string
    issuer: string
    client_id?: string
    require_verified_email?: boolean
  }>
  ssoRedirectUri?: string
  capabilityOptions?: Array<string>
}
type View = { data: Data; reload: () => void }

const ControlContext = createContext<View | undefined>(undefined)
export function useControlView() {
  const view = useContext(ControlContext)
  if (!view) throw new Error('Control pages require the app layout')
  return view
}

export function App() {
  const [data, setData] = useState<Data>()
  const [signOutError, setSignOutError] = useState('')
  const pathname = useLocation({ select: (location) => location.pathname })
  const page =
    Object.entries(pagePaths).find(
      ([, path]) => path === pathname || pathname.startsWith(path + '/'),
    )?.[0] ?? 'connections'
  const reload = () =>
    fetch('/api/admin').then(async (r) => setData(await r.json()))
  useEffect(() => void reload(), [])
  if (!data) return <div className="loading">Checking gateway state</div>
  if (data.state === 'bootstrap') return <Bootstrap done={reload} />
  if (data.state === 'login') return <Login providerId={data.loginProviderId} />
  if (data.state === 'forbidden')
    return (
      <AccessDenied
        reason={data.reason ?? 'not-added'}
        email={data.accessEmail}
      />
    )
  const manage =
    data.authorization?.administrator ||
    data.authorization?.capabilities.includes('manage_principals_groups')
  const administrationLinks = [
    ...(manage
      ? [
          ['users', 'Users'],
          ['groups', 'Groups'],
          ['services', 'Service Accounts'],
        ]
      : []),
    ...(data.authorization?.administrator ||
    data.authorization?.capabilities.includes('view_audit')
      ? [['audit', 'Audit']]
      : []),
  ]
  const links = [
    ['connections', 'MCP Connections'],
    ...administrationLinks,
    ['preferences', 'Settings'],
  ]
  return (
    <div className="app">
      <aside>
        <Logo />
        {data.organization?.display_name !== 'CoStack' && (
          <div className="org">{data.organization?.display_name}</div>
        )}
        <nav>
          <NavLinks links={[['connections', 'MCP Connections']]} page={page} />
          {administrationLinks.length > 0 && (
            <section>
              <h2>Administration</h2>
              <NavLinks links={administrationLinks} page={page} />
            </section>
          )}
          <section>
            <h2>Configuration</h2>
            <NavLinks links={[['preferences', 'Settings']]} page={page} />
          </section>
        </nav>
        <footer>
          <b>{data.me?.name}</b>
          <small>
            {data.authorization?.administrator ? 'Administrator' : 'Operator'}
          </small>
          <button
            aria-label="Sign out"
            title="Sign out"
            onClick={async () => {
              setSignOutError('')
              try {
                await act('sign-out')
                location.reload()
              } catch (error) {
                setSignOutError(
                  error instanceof Error ? error.message : 'Sign out failed',
                )
              }
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M16 17l5-5-5-5M21 12H9M10 4H5a2 2 0 00-2 2v12a2 2 0 002 2h5" />
            </svg>
          </button>
        </footer>
      </aside>
      <main>
        {signOutError && (
          <p className="error" role="alert">
            {signOutError}
          </p>
        )}
        {links.some(([id]) => id === page) ? (
          <ControlContext.Provider value={{ data, reload }}>
            <Outlet />
          </ControlContext.Provider>
        ) : (
          <p role="alert">You do not have access to this page.</p>
        )}{' '}
      </main>
    </div>
  )
}

function NavLinks({
  links,
  page,
}: {
  links: Array<Array<string>>
  page: string
}) {
  return links.map(([id, label]) => (
    <Link
      className={page === id ? 'active' : ''}
      aria-current={page === id ? 'page' : undefined}
      to={pagePaths[id as keyof typeof pagePaths]}
      key={id}
    >
      {label}
    </Link>
  ))
}

type ControlData = {
  organizationId?: string
  authorization: { administrator: boolean; capabilities: Array<string> }
  approvalMethod: 'gateway_enforced' | 'client_managed'
  connections: Array<{
    id: string
    display_name: string
    namespace: string
    transport: string
    state: string
    revision: number
    healthy: boolean | null
    error: string | null
    account_count: number
    icon?: string
    group_ids: Array<string>
  }>
  registrySources: Array<{
    id: string
    display_name: string
    base_url: string
    is_official: boolean
  }>
  auditRetentionDays: number
  audit: Array<Record<string, string | number | null>>
  detail?: {
    id: string
    display_name: string
    namespace: string
    transport: string
    transport_config: Record<string, unknown>
    state: 'enabled' | 'disabled'
    revision: number
    group_ids?: Array<string>
    personal_account_eligible: boolean
    has_oauth: boolean
    oauth_application?: OAuthClientSummary
    registry_source_id?: string | null
    registry_server_id?: string | null
    registry_version?: string | null
    error?: string
    policies: Array<ToolPolicy>
    tools: Array<{
      name: string
      description?: string
      policy: string
      annotations?: ToolAnnotations
    }>
    accounts: Array<{
      id: string
      kind: 'shared' | 'personal'
      owner_user_id?: string
      display_name: string
      namespace: string
      has_secret: boolean
      secret_names?: Array<string>
      variables?: Record<string, string>
    }>
  }
}

export function Connections({ data }: { data: Data }) {
  const [control, setControl] = useState<ControlData>()
  const { connection: selected } = useSearch({ from: '/_app/connections' })
  const navigate = useNavigate({ from: '/connections' })
  const setSelected = (connection: string) =>
    void navigate({ search: selected === connection ? {} : { connection } })
  const requestId = useRef(0)
  const load = async (id = selected) => {
    const currentRequest = ++requestId.current
    const r = await fetch(
      `/api/control${id ? `?connection=${encodeURIComponent(id)}` : ''}`,
    )
    if (r.ok) {
      const result = await r.json()
      if (currentRequest === requestId.current) setControl(result)
    }
  }
  useEffect(() => {
    void load()
    return () => {
      requestId.current++
    }
  }, [selected])
  const canConnections =
    data.authorization?.administrator ||
    data.authorization?.capabilities.includes('manage_connections')
  const canAccounts =
    data.authorization?.administrator ||
    data.authorization?.capabilities.includes('manage_accounts')
  if (!control) return <div className="loading">Loading MCP Connections</div>
  return (
    <Page
      title="MCP Connections"
      actions={
        <>
          <span>{control.connections.length} configured</span>
          {canConnections && (
            <Link className="primary" to="/connections/new">
              Add connection
            </Link>
          )}
        </>
      }
    >
      <div className="connection-list">
        {control.connections.length === 0 && (
          <ConnectionsEmptyState canAdd={Boolean(canConnections)} />
        )}
        {control.connections.map((connection) => {
          const expanded = selected === connection.id
          return (
            <article key={connection.id} className={expanded ? 'expanded' : ''}>
              <ConnectionSummary
                connection={connection}
                expanded={expanded}
                select={() => setSelected(connection.id)}
              />
              {expanded && control.detail?.id === connection.id && (
                <section className="connection-detail">
                  <ConnectionDetail
                    key={control.detail.id}
                    detail={control.detail}
                    canConnections={Boolean(canConnections)}
                    canAccounts={Boolean(canAccounts)}
                    reload={() => load(control.detail!.id)}
                  />
                </section>
              )}
            </article>
          )
        })}
      </div>
    </Page>
  )
}

export function ConnectionsEmptyState({ canAdd }: { canAdd: boolean }) {
  return (
    <div className="connection-empty">
      <b>No MCP connections yet</b>
      <span>
        {canAdd
          ? 'Choose Add connection to get started.'
          : 'Ask an administrator to add a connection.'}
      </span>
    </div>
  )
}

export function ConnectionSummary(p: {
  connection: ControlData['connections'][number]
  expanded: boolean
  select: () => void
}) {
  const c = p.connection
  return (
    <button
      className="connection-summary"
      aria-expanded={p.expanded}
      onClick={p.select}
    >
      <span className="connection-chevron" aria-hidden="true">
        <UiIcon name="chevronRight" />
      </span>
      <McpIcon src={c.icon} name={c.display_name} />
      <span className="connection-identity">
        <b>{c.display_name}</b>
        <code>{c.namespace}__*</code>
      </span>
      <Status ok={c.state === 'enabled'}>
        {c.state === 'enabled' ? 'Enabled' : 'Disabled'}
      </Status>
      <span className="account-count">
        {c.account_count} {c.account_count === 1 ? 'Account' : 'Accounts'}
      </span>
    </button>
  )
}

export function ConnectionForm(p: {
  data: Data
  organizationId: string
  initial?: ConnectionInput
  done: (id: string) => void
}) {
  const [kind, setKind] = useState<'streamable_http' | 'stdio'>(
    p.initial?.transport.kind ?? 'streamable_http',
  )
  const [displayName, setDisplayName] = useState(p.initial?.displayName ?? '')
  const [namespace, setNamespace] = useState(p.initial?.namespace ?? '')
  const needsTenantId =
    !p.initial?.registry &&
    p.initial?.transport.kind === 'streamable_http' &&
    p.initial.transport.url.includes('{tenantId}')
  return (
    <Form
      title={p.initial ? 'Review connection' : 'New MCP Connection'}
      submit="Validate and save"
      go={async (f) => {
        const policies = defaultToolPolicies()
        const transport =
          p.initial?.transport ??
          (kind === 'streamable_http'
            ? { kind, url: String(f.get('url')) }
            : {
                kind,
                ...parseStdioCommandLine(String(f.get('commandLine'))),
              })
        const result = await controlAct('create-connection', {
          input: {
            organizationId: p.organizationId,
            displayName: String(f.get('displayName')),
            namespace: String(f.get('namespace') || '') || undefined,
            transport: needsTenantId
              ? resolveBundledTransport(
                  transport,
                  String(f.get('tenantId') ?? ''),
                )
              : transport,
            state: 'enabled',
            groupIds: f.getAll('groups').map(String),
            policies,
            registry: p.initial?.registry,
          },
        })
        p.done(result.id)
      }}
    >
      <div className="form-grid">
        <Field label="Display name">
          <input
            name="displayName"
            required
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
          />
        </Field>
        <Field label="Namespace, fixed after save">
          <input
            name="namespace"
            value={namespace || deriveNamespace(displayName)}
            onChange={(e) => setNamespace(e.target.value)}
          />
        </Field>
      </div>
      {p.initial ? (
        <div className="registry-transport">
          <b>
            {p.initial.transport.kind === 'streamable_http'
              ? 'Streamable HTTP'
              : 'STDIO'}{' '}
            · {p.initial.registry ? 'From registry' : 'Bundled configuration'}
          </b>
          {p.initial.transport.kind === 'streamable_http' ? (
            <p>
              <code>{p.initial.transport.url}</code>
            </p>
          ) : (
            <p>
              <code>
                {[
                  p.initial.transport.command,
                  ...(p.initial.transport.args ?? []),
                ].join(' ')}
              </code>
            </p>
          )}
          <small>Uses the transport settings published by this server.</small>
          {needsTenantId && (
            <Field label="Microsoft Entra tenant ID">
              <input
                name="tenantId"
                required
                pattern={tenantIdPattern}
                placeholder="00000000-0000-0000-0000-000000000000"
              />
              <small>
                Find this in Microsoft Entra → Overview → Tenant ID. It replaces{' '}
                {'{tenantId}'} in the URL when you save.
              </small>
            </Field>
          )}
        </div>
      ) : (
        <>
          <div className="segmented">
            <button
              type="button"
              className={kind === 'streamable_http' ? 'on' : ''}
              onClick={() => setKind('streamable_http')}
            >
              Streamable HTTP
            </button>
            <button
              type="button"
              className={kind === 'stdio' ? 'on' : ''}
              onClick={() => setKind('stdio')}
            >
              STDIO
            </button>
          </div>
          {kind === 'streamable_http' ? (
            <Field label="HTTPS URL">
              <input
                name="url"
                type="url"
                required
                placeholder="https://mcp.example.com/mcp"
              />
            </Field>
          ) : (
            <Field label="Launch command">
              <input
                name="commandLine"
                required
                placeholder="bunx @scope/server@1.2.3"
                spellCheck={false}
              />
              <small>
                CoStack runs this command whenever it connects. A package runner
                such as bunx may download and cache the package first.
              </small>
              <div className="command-examples">
                <span>npm</span>
                <code>bunx @scope/server@1.2.3 --transport stdio</code>
                <span>NuGet</span>
                <code>dnx Example.Mcp.Server@1.2.3 -- --transport stdio</code>
              </div>
            </Field>
          )}
        </>
      )}{' '}
      <GroupChecks
        groups={p.data.groups ?? []}
        label="Group access"
        description="Select the Groups that should have access to this connection."
      />
      <p>
        Read-only tools start allowed; destructive tools require approval. Other
        tools start blocked. Adjust policies in Configure → Tools. Servers
        requiring authentication need an Account before discovery can succeed.
      </p>
    </Form>
  )
}

function ConnectionDetail(p: {
  detail: ControlData['detail']
  canConnections: boolean
  canAccounts: boolean
  reload: () => void
}) {
  const d = p.detail!
  const bundled = findBundledMcp(d.transport_config)
  const [credentials, setCredentials] = useState<string>()
  const [addingAccount, setAddingAccount] = useState(false)
  return (
    <>
      <header className="detail-head">
        <h3>Accounts</h3>
        <div className="detail-actions">
          <button className="primary" onClick={() => setAddingAccount(true)}>
            Add Account
          </button>
          {p.canConnections && (
            <Link
              className="secondary"
              to="/connections/$connectionId/configure"
              params={{ connectionId: d.id }}
              search={{ tab: 'connection' }}
            >
              Configure
            </Link>
          )}
        </div>
      </header>
      {d.accounts.length === 0 && (
        <p>
          No Accounts yet. Choose Add Account to sign in to this connection.
        </p>
      )}
      {!d.personal_account_eligible && (
        <p role="status">
          Personal sign-in requires a Group you belong to.{' '}
          {p.canConnections
            ? 'Choose Configure and assign that Group under Group access.'
            : 'Ask a connection manager to assign one of your Groups.'}
        </p>
      )}
      <div className="account-cards">
        {d.accounts.map((a) => (
          <article key={a.id}>
            <div>
              <b>{a.display_name}</b>
              <small>
                {a.kind} · {a.namespace}__*
              </small>
            </div>
            <Status ok={a.has_secret}>
              {a.has_secret ? 'Ready' : 'Needs credentials'}
            </Status>
            <button className="secondary" onClick={() => setCredentials(a.id)}>
              Reconfigure
            </button>
            <button
              className="danger"
              onClick={() =>
                controlAct(
                  a.kind === 'shared'
                    ? 'delete-shared-account'
                    : 'delete-personal-account',
                  { id: a.id },
                ).then(p.reload)
              }
            >
              Delete
            </button>
          </article>
        ))}
      </div>
      {credentials && (
        <Modal
          title="Reconfigure account"
          close={() => setCredentials(undefined)}
        >
          <AccountForm
            key={credentials}
            account={d.accounts.find((a) => a.id === credentials)!}
            connectionId={d.id}
            shared={p.canAccounts}
            oauth={d.transport === 'streamable_http'}
            personalEligible={d.personal_account_eligible}
            bundled={bundled}
            cancel={() => setCredentials(undefined)}
            done={() => {
              setCredentials(undefined)
              p.reload()
            }}
          />
        </Modal>
      )}
      {addingAccount && (
        <Modal
          title={`Add account${bundled ? ` to ${bundled.displayName}` : ''}`}
          close={() => setAddingAccount(false)}
        >
          <AccountForm
            key={d.id}
            connectionId={d.id}
            shared={p.canAccounts}
            oauth={d.transport === 'streamable_http'}
            personalEligible={d.personal_account_eligible}
            bundled={bundled}
            cancel={() => setAddingAccount(false)}
            done={() => {
              setAddingAccount(false)
              p.reload()
            }}
          />
        </Modal>
      )}
    </>
  )
}

function EditConnectionForm(p: {
  changed: () => void
  tab: 'connection' | 'tools'
  revert: () => void
  actions?: ReactNode
  groups: Array<Group>
  detail: NonNullable<ControlData['detail']>
  done: () => void
}) {
  const [policies, setPolicies] = useState(p.detail.policies)
  const [settingsChanged, setSettingsChanged] = useState(false)
  const d = p.detail
  const transport = d.transport_config
  const http = transport.kind === 'streamable_http'
  return (
    <div className="configuration-editor">
      <Form
        topActions
        actionControls={p.actions}
        revert={p.revert}
        submit="Save changes"
        go={async (f) => {
          if (!settingsChanged) {
            policies.forEach(validateToolPolicy)
            await controlAct('set-tool-policies', {
              id: d.id,
              revision: d.revision,
              policies,
            })
            p.done()
            return
          }
          policies.forEach(validateToolPolicy)
          const input = {
            organizationId: '',
            displayName: String(f.get('displayName')),
            transport: http
              ? { kind: 'streamable_http', url: String(f.get('url')) }
              : {
                  kind: 'stdio',
                  ...parseStdioCommandLine(String(f.get('commandLine'))),
                },
            state: d.state,
            groupIds: f.getAll('groups').map(String),
            policies,
            registry: d.registry_source_id
              ? {
                  sourceId: d.registry_source_id,
                  serverId: d.registry_server_id,
                  version: d.registry_version,
                }
              : undefined,
          }
          await controlAct('edit-connection', {
            id: d.id,
            revision: d.revision,
            input,
          })
          p.done()
        }}
      >
        <div
          className="configuration-fields"
          hidden={p.tab !== 'connection'}
          onChange={() => {
            setSettingsChanged(true)
            p.changed()
          }}
        >
          <Field label="Display name">
            <input name="displayName" defaultValue={d.display_name} required />
          </Field>
          {http ? (
            <Field label="HTTPS URL">
              <input
                name="url"
                type="url"
                defaultValue={String(transport.url ?? '')}
                required
              />
            </Field>
          ) : (
            <Field label="Launch command">
              <input
                name="commandLine"
                defaultValue={formatStdioCommandLine(
                  String(transport.command ?? ''),
                  Array.isArray(transport.args)
                    ? transport.args.map(String)
                    : undefined,
                )}
                required
                spellCheck={false}
              />
              <small>CoStack runs this command whenever it connects.</small>
            </Field>
          )}
          <GroupChecks
            groups={p.groups}
            selected={d.group_ids ?? []}
            label="Group access"
          />
          <p>
            Members of these Groups can create Personal Accounts and use this
            connection. Choose a Group you belong to before signing in
            personally.
          </p>
        </div>
        <div hidden={p.tab !== 'tools'}>
          <ToolPolicyEditor
            policies={policies}
            tools={d.tools}
            change={(value) => {
              setPolicies(value)
              p.changed()
            }}
          />
        </div>
        <p className="fine">
          A stale revision is rejected so another administrator's edit is not
          lost.
        </p>
      </Form>
    </div>
  )
}

function OAuthClientForm(p: {
  connectionId: string
  configuration?: OAuthClientSummary | undefined
  done: () => void
}) {
  const [saved, setSaved] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const hasSecret = p.configuration?.hasSecret || saved
  return (
    <Form
      compact
      className="oauth-client-form"
      title="Upstream OAuth application"
      submit="Save OAuth application"
      resetOnSuccess={false}
      go={async (f) => {
        await controlAct('configure-upstream-oauth', {
          connectionId: p.connectionId,
          config: {
            clientId: String(f.get('clientId')),
            clientSecret: secret ?? '',
            scope: String(f.get('scope') || '') || undefined,
          },
        })
        setSecret(null)
        setSaved(true)
        p.done()
      }}
    >
      <p role="status">
        {saved
          ? 'OAuth application saved.'
          : p.configuration
            ? 'OAuth application configured.'
            : 'No OAuth application configured yet.'}
        {hasSecret && ' Enter a new secret only to replace the saved value.'}
      </p>
      <Field label="Client ID">
        <input
          name="clientId"
          required
          defaultValue={p.configuration?.clientId}
          onChange={() => setSaved(false)}
        />
      </Field>
      <Field label="Client secret">
        <input
          name="clientSecret"
          type="password"
          autoComplete="off"
          data-lpignore="true"
          data-1p-ignore=""
          data-bwignore=""
          required={!hasSecret}
          value={secret ?? (hasSecret ? '********' : '')}
          onChange={(e) => {
            setSecret(e.target.value)
            setSaved(false)
          }}
          onFocus={(e) => {
            if (secret === null) e.target.select()
          }}
        />
      </Field>
      <Field label="Scopes">
        <input
          name="scope"
          placeholder="openid profile"
          defaultValue={p.configuration?.scope}
          onChange={() => setSaved(false)}
        />
      </Field>
    </Form>
  )
}

function AccountForm(p: {
  account?: NonNullable<ControlData['detail']>['accounts'][number]
  connectionId: string
  shared: boolean
  oauth: boolean
  personalEligible: boolean
  bundled: BundledMcp | undefined
  cancel: () => void
  done: () => void
}) {
  const [kind, setKind] = useState<'personal' | 'shared'>(
    p.account?.kind ?? 'personal',
  )
  const [manual, setManual] = useState(!p.oauth)
  const savedNames = p.account?.secret_names ?? []
  const savedRows = [
    ...Object.entries(p.account?.variables ?? {}).map(([name, value]) => ({
      name,
      value,
      secret: false,
    })),
    ...savedNames.map((name) => ({ name, value: '', secret: true })),
  ]
  const blankRow = { name: '', value: '', secret: true }
  const [environment, setEnvironment] = useState(
    savedRows.length ? savedRows : [blankRow],
  )
  const [createdId, setCreatedId] = useState<string>()
  return (
    <Form
      submit={
        manual
          ? p.account
            ? 'Save credentials'
            : 'Add Account'
          : 'Sign in with OAuth'
      }
      submitIcon={manual ? <AddAccountIcon /> : <OAuthIcon />}
      cancel={p.cancel}
      disabled={!p.account && kind === 'personal' && !p.personalEligible}
      go={async (f) => {
        const variables = environment
          .map((row) => ({ ...row, name: row.name.trim() }))
          .filter((row) => row.name || row.value)
        if (manual && !p.oauth) {
          const names = variables.map((row) => row.name)
          if (names.some((name) => !name))
            throw Error('Environment variable names must not be blank')
          if (new Set(names).size !== names.length)
            throw Error('Environment variable names must be unique')
        }
        const secrets = manual
          ? p.oauth
            ? JSON.parse(String(f.get('secrets') || '{}'))
            : Object.fromEntries(
                variables
                  .filter((row) => row.secret)
                  .map((row) => [row.name, row.value]),
              )
          : undefined
        const plainVariables =
          manual && !p.oauth
            ? Object.fromEntries(
                variables
                  .filter((row) => !row.secret)
                  .map((row) => [row.name, row.value]),
              )
            : undefined
        const account =
          p.account ??
          (createdId
            ? { id: createdId }
            : await controlAct(
                kind === 'shared'
                  ? 'create-shared-account'
                  : 'create-personal-account',
                {
                  connectionId: p.connectionId,
                  displayName: String(f.get('displayName')),
                  secrets,
                  variables: plainVariables,
                },
              ))
        if (manual && p.account) {
          await controlAct(`replace-${kind}-secret`, {
            id: account.id,
            secrets,
            variables: plainVariables,
          })
        }
        if (!manual) {
          setCreatedId(account.id)
          const result = await upstreamOAuthStart(account.id)
          location.assign(result.authorizationUrl)
          return
        }
        p.done()
      }}
    >
      <Field label="Account display name">
        <input
          name="displayName"
          required
          defaultValue={p.account?.display_name ?? 'My account'}
          readOnly={!!p.account || !!createdId}
        />
      </Field>
      {p.shared && !p.account && (
        <div className="segmented">
          <button
            type="button"
            disabled={!!createdId}
            className={kind === 'personal' ? 'on' : ''}
            onClick={() => setKind('personal')}
          >
            Personal
          </button>
          <button
            type="button"
            disabled={!!createdId}
            className={kind === 'shared' ? 'on' : ''}
            onClick={() => setKind('shared')}
          >
            Shared
          </button>
        </div>
      )}
      {p.oauth && (
        <>
          <p>
            Sign in on the server’s authorization page. CoStack discovers OAuth
            settings and registers automatically when supported.
          </p>
          <label className="toggle">
            <input
              type="checkbox"
              checked={manual}
              disabled={!!createdId}
              onChange={(e) => setManual(e.target.checked)}
            />
            <span>Use manual credentials instead</span>
          </label>
        </>
      )}
      {manual && p.oauth && (
        <Field label="HTTP headers as JSON">
          <textarea
            name="secrets"
            defaultValue={p.bundled?.manualCredentials ?? '{}'}
            spellCheck={false}
          />
        </Field>
      )}
      {manual && !p.oauth && (
        <div className="environment-fields">
          <strong>Environment variables</strong>
          <p className="note">
            Passed to the server process. Secret values are stored encrypted and
            never shown again.
            {savedNames.length > 0 &&
              ' Leave a secret blank to keep its saved value; removing a row deletes it.'}
          </p>
          {environment.map((row, index) => (
            <div className="environment-row" key={index}>
              <Field label="Name">
                <input
                  aria-label={`Environment variable ${index + 1} name`}
                  placeholder="API_KEY"
                  value={row.name}
                  required={!!row.value}
                  pattern="[^=\u0000]+"
                  autoComplete="off"
                  data-lpignore="true"
                  data-1p-ignore=""
                  data-bwignore=""
                  spellCheck={false}
                  onChange={(e) =>
                    setEnvironment(
                      environment.map((item, i) =>
                        i === index ? { ...item, name: e.target.value } : item,
                      ),
                    )
                  }
                />
              </Field>
              <Field label="Value">
                <input
                  aria-label={`Environment variable ${index + 1} value`}
                  type={row.secret ? 'password' : 'text'}
                  autoComplete="off"
                  data-lpignore="true"
                  data-1p-ignore=""
                  data-bwignore=""
                  placeholder={
                    row.secret && savedNames.includes(row.name)
                      ? '••••••••'
                      : ''
                  }
                  value={row.value}
                  onChange={(e) =>
                    setEnvironment(
                      environment.map((item, i) =>
                        i === index ? { ...item, value: e.target.value } : item,
                      ),
                    )
                  }
                />
              </Field>
              <button
                type="button"
                className="secondary environment-secret"
                aria-pressed={row.secret}
                aria-label={`Environment variable ${index + 1} is secret`}
                title={
                  row.secret
                    ? 'Secret: stored encrypted and never shown again'
                    : 'Plain: shown when reconfiguring'
                }
                onClick={() =>
                  setEnvironment(
                    environment.map((item, i) =>
                      i === index
                        ? { ...item, secret: !item.secret, value: '' }
                        : item,
                    ),
                  )
                }
              >
                <UiIcon name={row.secret ? 'lock' : 'unlock'} />
              </button>
              <button
                type="button"
                className="secondary environment-remove"
                aria-label={`Remove environment variable ${index + 1}`}
                onClick={() =>
                  setEnvironment(environment.filter((_, i) => i !== index))
                }
              >
                <UiIcon name="close" />
              </button>
            </div>
          ))}
          <button
            type="button"
            className="secondary"
            onClick={() => setEnvironment([...environment, blankRow])}
          >
            Add variable
          </button>
        </div>
      )}
    </Form>
  )
}

function RegistryPanel(p: {
  manual: () => void
  data: Data
  control: ControlData
  reload: () => void
  done: (id: string) => void
}) {
  const [prefill, setPrefill] = useState<ConnectionInput>()
  const [adding, setAdding] = useState(false)
  const [sourceId, setSourceId] = useState(
    p.control.registrySources[0]?.id ?? '',
  )
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState<string>()
  const [results, setResults] = useState<Array<RegistryServer>>([])
  const [nextCursor, setNextCursor] = useState<string>()
  const [loading, setLoading] = useState(true)
  const [importing, setImporting] = useState(false)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    const timer = setTimeout(() => {
      controlAct('browse-registry', { sourceId, search: query.trim(), cursor })
        .then((result) => {
          if (cancelled) return
          setResults((previous) =>
            cursor ? [...previous, ...result.servers] : result.servers,
          )
          setNextCursor(result.metadata?.nextCursor)
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message)
        })
        .finally(() => {
          if (!cancelled) setLoading(false)
        })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [sourceId, query, cursor, retry])
  if (prefill)
    return (
      <section className="registry">
        <button className="secondary" onClick={() => setPrefill(undefined)}>
          <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M13 8H3m5-5L3 8l5 5"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Back to registry
        </button>
        {prefill.registry ? (
          <p>
            <b>{prefill.registry.serverId}</b> · Version{' '}
            {prefill.registry.version}
          </p>
        ) : (
          <BundledMcpSetup entry={findBundledMcp(prefill.transport)} />
        )}
        <p>
          Choose a local name and Group access, then save. After saving, add an
          Account and configure Tool Policies.
        </p>
        <ConnectionForm
          data={p.data}
          organizationId={p.control.organizationId!}
          initial={prefill}
          done={p.done}
        />
      </section>
    )
  return (
    <section className="registry" aria-label="Browse MCP registry">
      <div className="connection-options">
        <div>
          <h2>Choose an MCP server</h2>
          <p>
            Use a bundled configuration, search a registry, or enter your own
            settings.
          </p>
        </div>
        <button className="secondary" onClick={p.manual}>
          Enter settings manually
        </button>
      </div>
      <BundledMcpCards
        select={(entry) =>
          setPrefill(bundledPrefill(entry, p.control.organizationId!))
        }
      />
      <h3 className="registry-search-heading">Search registry</h3>
      <div className="registry-search">
        <Field label="Registry">
          <select
            value={sourceId}
            disabled={importing}
            onChange={(e) => {
              setSourceId(e.target.value)
              setCursor(undefined)
              setResults([])
              setNextCursor(undefined)
            }}
          >
            {p.control.registrySources.map((s) => (
              <option value={s.id} key={s.id}>
                {s.display_name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Search servers">
          <input
            value={query}
            disabled={importing}
            type="search"
            onChange={(e) => {
              setQuery(e.target.value)
              setCursor(undefined)
              setResults([])
              setNextCursor(undefined)
            }}
            placeholder="e.g. github or filesystem"
          />
        </Field>
      </div>
      {error && (
        <div role="alert">
          <p className="error">{error}</p>
          <button
            className="secondary"
            disabled={loading || importing}
            onClick={() => {
              setCursor(undefined)
              setResults([])
              setRetry((value) => value + 1)
            }}
          >
            Retry
          </button>
        </div>
      )}
      <div className="registry-results" aria-busy={loading || importing}>
        {rankRegistryServers(
          results.filter(
            (entry) =>
              !isBundledRegistryEntry(
                entry,
                p.control.registrySources.find(
                  (source) => source.id === sourceId,
                )?.base_url ?? '',
                '',
              ),
          ),
          p.control.registrySources.find((source) => source.id === sourceId)
            ?.base_url ?? '',
        ).map(({ server }) => (
          <article key={`${server.name}:${server.version}`}>
            <McpIcon
              src={
                server.icons?.find(
                  (icon) =>
                    icon.theme !== 'dark' && icon.src.startsWith('https://'),
                )?.src
              }
              name={server.title || server.name}
            />
            <div className="registry-result-content">
              <div className="registry-result-title">
                <b>{server.title || server.name}</b>
                {server.title && <small>{server.name}</small>}
              </div>
              {server.remotes?.find(
                (remote) => remote.type === 'streamable-http',
              ) && (
                <small>
                  <code>
                    {
                      server.remotes.find(
                        (remote) => remote.type === 'streamable-http',
                      )!.url
                    }
                  </code>
                </small>
              )}
              <small>Version {server.version}</small>
              <p>{server.description || 'No description provided.'}</p>
            </div>
            <button
              className="secondary"
              disabled={loading || importing}
              onClick={async () => {
                setImporting(true)
                setError('')
                try {
                  const result = await controlAct('import-registry', {
                    sourceId,
                    serverName: server.name,
                    version: server.version,
                    organizationId: p.control.organizationId,
                  })
                  setPrefill(result.input)
                } catch (e) {
                  setError(
                    e instanceof Error ? e.message : 'Could not load server',
                  )
                } finally {
                  setImporting(false)
                }
              }}
            >
              Use this server
            </button>
          </article>
        ))}
      </div>
      {loading && <p role="status">Loading servers…</p>}
      {importing && <p role="status">Loading connection settings…</p>}
      {!loading &&
        !error &&
        results.length === 0 &&
        searchBundledMcps(query).length === 0 && (
          <p role="status">
            No servers found. Try a shorter name or another registry.
          </p>
        )}
      {nextCursor && !error && (
        <button
          className="secondary"
          disabled={loading || importing}
          onClick={() => setCursor(nextCursor)}
        >
          Load more servers
        </button>
      )}
      <details
        className="registry-sources"
        open={adding}
        onToggle={(e) => setAdding(e.currentTarget.open)}
      >
        <summary>Add a registry source</summary>
        {adding && (
          <Form
            submit="Add source"
            go={async (f) => {
              await controlAct('create-registry-source', {
                organizationId: p.control.organizationId,
                displayName: String(f.get('displayName')),
                baseUrl: String(f.get('baseUrl')),
              })
              setAdding(false)
              p.reload()
            }}
          >
            <Field label="Display name">
              <input name="displayName" required />
            </Field>
            <Field label="Registry URL">
              <input
                name="baseUrl"
                type="url"
                required
                placeholder="https://registry.example.com"
              />
            </Field>
          </Form>
        )}
      </details>
    </section>
  )
}
export function Preferences({ embedded = false }: { embedded?: boolean }) {
  const [data, setData] = useState<ControlData>()
  useEffect(
    () =>
      void fetch('/api/control')
        .then((r) => r.json())
        .then(setData),
    [],
  )
  if (!data) return null
  const content = (
    <>
      {embedded && <h2>Approval method</h2>}
      <p className="note">
        Choose how approval-required tools ask before execution.
      </p>
      <fieldset className="approval-methods" aria-label="Approval method">
        {(['gateway_enforced', 'client_managed'] as const).map((method) => (
          <label className="approval-method" key={method}>
            <input
              type="radio"
              name="approvalMethod"
              value={method}
              checked={data.approvalMethod === method}
              aria-describedby={`${method}-description`}
              onChange={() =>
                controlAct('set-approval-method', { method }).then(() =>
                  setData({ ...data, approvalMethod: method }),
                )
              }
            />
            <span>
              <strong>{human(method)}</strong>
              <span id={`${method}-description`} className="note">
                {method === 'gateway_enforced'
                  ? 'The gateway verifies approval through MCP input_required.'
                  : 'Trust the MCP Client to prompt before it calls the marked tool.'}
              </span>
            </span>
          </label>
        ))}
      </fieldset>
    </>
  )
  return embedded ? content : <Page title="Approval Method">{content}</Page>
}

export function Audit() {
  const [data, setData] = useState<ControlData>()
  const [filters, setFilters] = useState({
    principal: '',
    connection: '',
    outcome: '',
  })
  const query = new URLSearchParams(
    Object.entries(filters).filter(([, value]) => value),
  ).toString()
  const load = (params = '') =>
    fetch(`/api/control${params}`)
      .then((r) => r.json())
      .then(setData)
  useEffect(() => void load(), [])
  if (!data) return null
  return (
    <Page
      title="Audit"
      actions={
        <>
          {data.authorization.administrator && (
            <label className="field">
              <span>Retention</span>
              <select
                value={data.auditRetentionDays}
                onChange={(e) =>
                  controlAct('set-audit-retention', {
                    days: Number(e.target.value),
                  }).then(() =>
                    setData({
                      ...data,
                      auditRetentionDays: Number(e.target.value),
                    }),
                  )
                }
              >
                {[30, 90, 180, 365].map((x) => (
                  <option key={x} value={x}>
                    {x} days
                  </option>
                ))}
              </select>
            </label>
          )}
          <a
            className="primary"
            href={`/api/control?download=audit${query ? `&${query}` : ''}`}
          >
            Download JSONL <UiIcon name="download" />
          </a>
        </>
      }
    >
      <p className="note">
        Metadata only. CoStack never stores tool arguments or results.
      </p>
      <div className="toolbar">
        <form
          className="audit-filters"
          onSubmit={(e) => {
            e.preventDefault()
            load(query ? `?${query}` : '')
          }}
        >
          <input
            aria-label="Principal ID"
            value={filters.principal}
            onChange={(e) =>
              setFilters({ ...filters, principal: e.target.value })
            }
            placeholder="Principal ID"
          />
          <input
            aria-label="Connection ID"
            value={filters.connection}
            onChange={(e) =>
              setFilters({ ...filters, connection: e.target.value })
            }
            placeholder="Connection ID"
          />
          <select
            aria-label="Outcome"
            value={filters.outcome}
            onChange={(e) =>
              setFilters({ ...filters, outcome: e.target.value })
            }
          >
            <option value="">Any outcome</option>
            <option value="success">Success</option>
            <option value="denied">Denied</option>
            <option value="error">Error</option>
          </select>
          <button className="secondary">Apply filters</button>
        </form>
      </div>
      <div className="audit-table">
        {data.audit.map((row, i) => (
          <article key={i}>
            <code>{new Date(String(row.occurred_at)).toLocaleString()}</code>
            <b>{String(row.principal_display_name ?? 'Deleted Principal')}</b>
            <span>{String(row.tool_name ?? row.outcome)}</span>
            <Status ok={row.outcome === 'success'}>
              {String(row.outcome)}
            </Status>
          </article>
        ))}
      </div>
    </Page>
  )
}

async function controlAct(action: string, body: Record<string, unknown> = {}) {
  const r = await fetch('/api/control', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw Error(d.error ?? 'Request failed')
  return d
}
async function upstreamOAuthStart(accountId: string) {
  const r = await fetch('/api/upstream-oauth/start', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accountId }),
  })
  const data = await r.json()
  if (!r.ok) throw Error(data.error ?? 'OAuth failed')
  return data as { authorizationUrl: string }
}
export function Overview({ data }: { data: Data }) {
  return (
    <Page title="Identity control">
      <div className="metrics">
        <Metric
          n={data.users?.filter((x) => !x.disabled_at).length ?? 0}
          label="Active users"
        />
        <Metric n={data.groups?.length ?? 0} label="Groups" />
        <Metric
          n={data.serviceAccounts?.length ?? 0}
          label="Service Accounts"
        />
        <Metric
          n={
            data.access?.filter((x) => !x.claimed_at && !x.revoked_at).length ??
            0
          }
          label="Awaiting sign-in"
        />
      </div>
      <section className="signal">
        <i />
        <div>
          <code>AUTHENTICATION POSTURE</code>
          <h2>
            {data.providers?.length
              ? 'Single sign-on connected'
              : 'Recovery access only'}
          </h2>
          <p>
            {data.providers?.length
              ? 'Your OIDC provider handles Organization sign-in.'
              : 'Configure OIDC before onboarding users.'}
          </p>
        </div>
      </section>
    </Page>
  )
}
export function Users({ data, reload }: View) {
  const [signInUrl, setSignInUrl] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => setSignInUrl(location.origin), [])
  return (
    <Page title="Users">
      <section className="user-section">
        <h2>Add user</h2>
        <p className="note">
          Enter their verified SSO email and choose their Groups. Then send them
          the sign-in URL. They must sign in within seven days to claim access.
        </p>
        <div className="sign-in-link">
          <code>{signInUrl || 'Loading sign-in URL…'}</code>
          <button
            className="secondary"
            type="button"
            disabled={!signInUrl}
            onClick={async () => {
              await navigator.clipboard.writeText(signInUrl)
              setCopied(true)
            }}
          >
            {copied ? 'Copied' : 'Copy sign-in URL'}
          </button>
        </div>
        <Form
          submit="Add user"
          submitIcon={<AddAccountIcon />}
          go={async (f) => {
            await act('create-access', {
              email: f.get('email'),
              groupIds: f.getAll('groups'),
            })
            reload()
          }}
        >
          <Field label="Verified email">
            <input
              name="email"
              type="email"
              required
              placeholder="name@company.com"
            />
          </Field>
          <GroupChecks groups={data.groups ?? []} />
        </Form>
      </section>
      <section className="user-section">
        <h2>Pending access</h2>
        <Rows>
          {data.access?.map((x) => (
            <article key={x.id}>
              <div>
                <b>{x.normalized_email}</b>
                <small>
                  {x.claimed_at
                    ? 'Claimed'
                    : x.revoked_at
                      ? 'Revoked'
                      : `Expires ${new Date(x.expires_at).toLocaleDateString()}`}
                </small>
              </div>
              <Chips
                values={data.groups
                  ?.filter((g) => x.group_ids.includes(g.id))
                  .map((g) => g.display_name)}
              />
              {!x.claimed_at && !x.revoked_at && (
                <button
                  className="danger"
                  onClick={() =>
                    act('revoke-access', { id: x.id }).then(reload)
                  }
                >
                  Revoke
                </button>
              )}
            </article>
          ))}
        </Rows>
      </section>
      <section className="user-section">
        <h2>Users</h2>
        <Rows>
          {data.users?.map((u) => (
            <article key={u.id}>
              <div>
                <b>{u.display_name}</b>
                <small>{u.email}</small>
              </div>
              <Chips
                values={data.groups
                  ?.filter((g) => u.group_ids.includes(g.id))
                  .map((g) => g.display_name)}
              />
              <Status ok={!u.disabled_at}>
                {u.disabled_at ? 'Suspended' : 'Active'}
              </Status>
              <button
                className="danger"
                onClick={() =>
                  act('set-disabled', {
                    id: u.id,
                    disabled: !u.disabled_at,
                  }).then(reload)
                }
              >
                {u.disabled_at ? 'Restore' : 'Suspend'}
              </button>
            </article>
          ))}
        </Rows>
      </section>
    </Page>
  )
}
export function Groups({ data, reload }: View) {
  const [selected, setSelected] = useState(data.groups?.[0]?.id)
  const group = data.groups?.find((g) => g.id === selected)
  const principals = [...(data.users ?? []), ...(data.serviceAccounts ?? [])]
  return (
    <Page title="Groups">
      <Form
        compact
        submit="Create group"
        go={async (f) => {
          await act('create-group', { name: f.get('name') })
          reload()
        }}
      >
        <Field label="Group name">
          <input name="name" required placeholder="Platform engineering" />
        </Field>
      </Form>
      <div className="split">
        <div className="group-list">
          {data.groups?.map((g) => (
            <button
              className={selected === g.id ? 'selected' : ''}
              onClick={() => setSelected(g.id)}
              key={g.id}
            >
              <b>{g.display_name}</b>
              <small>
                {principals.filter((p) => p.group_ids.includes(g.id)).length}{' '}
                members
              </small>
            </button>
          ))}
        </div>
        {group && (
          <section className="inspector">
            <code>
              {group.is_administrators ? 'PROTECTED GROUP' : 'GROUP DETAIL'}
            </code>
            <h2>{group.display_name}</h2>
            <h3>Members</h3>
            {principals.map((p) => (
              <Toggle
                key={p.id}
                checked={p.group_ids.includes(group.id)}
                label={p.display_name}
                change={(v) =>
                  act('set-membership', {
                    groupId: group.id,
                    principalId: p.id,
                    enabled: v,
                  }).then(reload)
                }
              />
            ))}
            <h3>Capabilities</h3>
            {data.capabilityOptions?.map((c) => (
              <Toggle
                key={c}
                disabled={group.is_administrators}
                checked={
                  group.is_administrators || group.capabilities.includes(c)
                }
                label={human(c)}
                change={(v) =>
                  act('set-capabilities', {
                    groupId: group.id,
                    capabilities: v
                      ? [...group.capabilities, c]
                      : group.capabilities.filter((x) => x !== c),
                  }).then(reload)
                }
              />
            ))}
          </section>
        )}
      </div>
    </Page>
  )
}
export function Services({ data, reload }: View) {
  const [credential, setCredential] = useState<{
    clientId: string
    clientSecret: string
  }>()
  return (
    <Page title="Service Accounts">
      <p className="note">
        Credentials appear once. Store them before leaving this page.
      </p>
      {credential && (
        <div className="secret">
          <code>NEW CLIENT CREDENTIAL</code>
          <p>This secret cannot be shown again.</p>
          <pre>{credential.clientId}</pre>
          <pre>{credential.clientSecret}</pre>
          <button onClick={() => setCredential(undefined)}>
            I have stored it
          </button>
        </div>
      )}
      <Form
        submit="Create Service Account"
        go={async (f) => {
          const r = await act('create-service-account', {
            name: f.get('name'),
            groupIds: f.getAll('groups'),
          })
          setCredential(r.credential)
          reload()
        }}
      >
        <Field label="Display name">
          <input name="name" required placeholder="Build automation" />
        </Field>
        <GroupChecks groups={data.groups ?? []} />
      </Form>
      <Rows>
        {data.serviceAccounts?.map((s) => (
          <article key={s.id}>
            <div>
              <b>{s.display_name}</b>
              <small>{s.oauth_client_id}</small>
            </div>
            <Status ok={!s.disabled_at}>
              {s.disabled_at ? 'Suspended' : 'Active'}
            </Status>
            <button
              className="danger"
              onClick={() =>
                act('set-disabled', {
                  id: s.id,
                  disabled: !s.disabled_at,
                }).then(reload)
              }
            >
              {s.disabled_at ? 'Restore' : 'Suspend'}
            </button>
          </article>
        ))}
      </Rows>
    </Page>
  )
}
export function Sso({
  data,
  reload,
  embedded = false,
}: View & { embedded?: boolean }) {
  const p = data.providers?.[0]
  const [saved, setSaved] = useState(false)
  const [secret, setSecret] = useState<string | null>(null)
  const configured = !!p || saved
  const content = (
    <>
      {embedded && <h2>Single sign-on</h2>}
      <Form
        className="sso-form"
        submit={configured ? 'Save changes' : 'Save provider'}
        submitIcon={null}
        resetOnSuccess={false}
        go={async (f) => {
          await act('save-sso', {
            ...Object.fromEntries(f),
            clientSecret: secret ?? '',
            requireVerifiedEmail: f.has('requireVerifiedEmail'),
          })
          setSecret(null)
          setSaved(true)
          reload()
        }}
      >
        <p role="status">
          {saved ? 'Changes saved. ' : ''}
          {configured
            ? 'Provider configured in CoStack.'
            : 'No SSO provider configured yet.'}
        </p>
        <div className="form-grid" onChange={() => setSaved(false)}>
          <Field label="Issuer URL">
            <input name="issuer" type="url" required defaultValue={p?.issuer} />
          </Field>
          <Field label="Client ID">
            <input name="clientId" required defaultValue={p?.client_id} />
          </Field>
          <Field label="Client secret">
            <input
              name="clientSecret"
              type="password"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore=""
              data-bwignore=""
              required={!configured}
              value={secret ?? (configured ? '********' : '')}
              onChange={(e) => setSecret(e.target.value)}
              onFocus={(e) => {
                if (secret === null) e.target.select()
              }}
            />
            {configured && (
              <small>Enter a new secret to replace the stored value.</small>
            )}
          </Field>
          <div className="field">
            <label className="toggle">
              <input
                type="checkbox"
                name="requireVerifiedEmail"
                defaultChecked={p?.require_verified_email ?? true}
              />{' '}
              Require verified email
            </label>
            <small>
              When disabled, CoStack trusts the configured provider’s email for
              matching admin-added Users, even if the provider does not mark it
              verified.
            </small>
          </div>
          {data.ssoRedirectUri && (
            <Field label="Redirect URI">
              <input
                readOnly
                value={data.ssoRedirectUri}
                onFocus={(e) => e.target.select()}
              />
              <small>
                Register this exact URI in your identity provider before signing
                in. Saving here does not configure or verify the identity
                provider.
              </small>
            </Field>
          )}
        </div>
      </Form>
    </>
  )
  return embedded ? content : <Page title="Single sign-on">{content}</Page>
}
export function Settings() {
  const view = useControlView()
  const canManageSso =
    view.data.authorization?.administrator ||
    view.data.authorization?.capabilities.includes('manage_sso')
  return (
    <Page title="Settings">
      <section className="settings-section">
        <Preferences embedded />
      </section>
      {canManageSso && (
        <section className="settings-section">
          <Sso {...view} embedded />
        </section>
      )}
    </Page>
  )
}
function Bootstrap({ done }: { done: () => void }) {
  return (
    <div className="entry">
      <EntryArt
        code="01 / INITIALIZE"
        title="Bring the gateway online."
        text="Create the Organization and its recovery Administrator."
      />
      <Form
        title="First-run setup"
        submit="Initialize CoStack"
        go={async (f) => {
          const r = await fetch('/api/setup/bootstrap', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(Object.fromEntries(f)),
          })
          if (!r.ok) throw Error((await r.json()).error)
          done()
        }}
      >
        <Field label="Bootstrap token">
          <input name="token" type="password" required />
        </Field>
        <Field label="Organization">
          <input name="organizationName" required />
        </Field>
        <Field label="Administrator email">
          <input name="administratorEmail" type="email" required />
        </Field>
        <Field label="Recovery password">
          <input
            name="administratorPassword"
            type="password"
            minLength={12}
            required
          />
        </Field>
      </Form>
    </div>
  )
}
export function AccessDenied({
  reason,
  email,
}: {
  reason: AccessDeniedReason
  email?: string | undefined
}) {
  const [error, setError] = useState('')
  const [signingOut, setSigningOut] = useState(false)
  return (
    <div className="entry">
      <EntryArt
        code="ACCESS / CONTROL"
        title="Access needs attention."
        text="Contact your Organization’s administrator to complete sign-in setup."
      />
      <div className="login">
        <Logo />
        <h2>
          {reason === 'email-unverified'
            ? 'Email verification required'
            : 'Access required'}
        </h2>
        {email && (
          <p>
            Email: <strong>{email}</strong>
          </p>
        )}
        <p>
          {reason === 'email-unverified'
            ? 'Your identity provider did not confirm that your email is verified. Ask your administrator to check the SSO configuration. Adding your email as a User alone will not resolve this.'
            : reason === 'disabled'
              ? 'Your access has been disabled. Ask your administrator to restore it.'
              : 'An administrator needs to add your SSO email as a User before you can access CoStack. Once added, sign in again.'}
        </p>
        <button
          className="primary"
          disabled={signingOut}
          onClick={async () => {
            setError('')
            setSigningOut(true)
            try {
              await act('sign-out')
              location.replace('/connections')
            } catch (failure) {
              setError(
                failure instanceof Error ? failure.message : 'Sign out failed',
              )
              setSigningOut(false)
            }
          }}
        >
          {signingOut ? 'Signing out…' : 'Sign out and return to sign in'}
        </button>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}

function Login({ providerId }: { providerId: string | undefined }) {
  const [error, setError] = useState('')
  return (
    <div className="entry">
      <EntryArt
        code="ACCESS / CONTROL"
        title="Your tools. One guarded door."
        text="Sign in to administer CoStack or connect your MCP Client."
      />
      <div className="login">
        <Logo />
        <h2>Sign in</h2>
        <p>Continue with your Organization's identity provider.</p>
        <button
          className="primary"
          onClick={async () => {
            const r = await fetch('/api/auth/sign-in/sso', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({
                callbackURL: location.pathname + location.search,
                providerId,
              }),
            })
            const d = await r.json()
            if (d.url) location.href = d.url
            else setError('SSO is not configured')
          }}
        >
          Continue with SSO{' '}
          <span className="button-icon">
            <OAuthIcon />
          </span>
        </button>
        <div className="or">recovery or development</div>
        <form
          onSubmit={async (e) => {
            e.preventDefault()
            const r = await fetch('/api/auth/sign-in/email', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(
                Object.fromEntries(new FormData(e.currentTarget)),
              ),
            })
            if (r.ok) location.reload()
            else setError('Email or password was not accepted')
          }}
        >
          <Field label="Email">
            <input name="email" type="email" required />
          </Field>
          <Field label="Password">
            <input name="password" type="password" required />
          </Field>
          <button className="secondary">Recovery sign in</button>
        </form>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}
function Page(p: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="page">
      <PageBar title={p.title} actions={p.actions} />
      {p.children}
    </div>
  )
}
function PageBar(p: { title: string; actions?: ReactNode }) {
  return (
    <header className="page-bar">
      <h1>{p.title}</h1>
      {p.actions && <div className="page-actions">{p.actions}</div>}
    </header>
  )
}
function Logo() {
  return (
    <a className="logo" href="/">
      <BrandIcon />
      <b>CoStack</b>
    </a>
  )
}
function EntryArt(p: { code: string; title: string; text: string }) {
  return (
    <section className="entry-art">
      <code>{p.code}</code>
      <h1>{p.title}</h1>
      <p>{p.text}</p>
    </section>
  )
}
function Metric({ n, label }: { n: number; label: string }) {
  return (
    <div className="metric">
      <b>{String(n).padStart(2, '0')}</b>
      <span>{label}</span>
    </div>
  )
}
function Rows({ children }: { children: ReactNode }) {
  return <div className="rows">{children}</div>
}
function Chips({ values }: { values: Array<string> | undefined }) {
  return (
    <div className="chips">
      {values?.map((x) => (
        <span key={x}>{x}</span>
      ))}
    </div>
  )
}
function Status({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className={`status ${ok ? 'ok' : 'off'}`}>
      <i />
      {children}
    </span>
  )
}
function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  )
}
function GroupChecks({
  groups,
  selected = [],
  label = 'Initial Groups',
  description,
}: {
  groups: Array<Group>
  selected?: Array<string>
  label?: string
  description?: string
}) {
  return (
    <fieldset className="group-checks">
      <legend>{label}</legend>
      {description && <p>{description}</p>}
      {groups.map((g) => (
        <label className="check" key={g.id}>
          <input
            name="groups"
            value={g.id}
            type="checkbox"
            defaultChecked={selected.includes(g.id)}
          />
          <span>{g.display_name}</span>
        </label>
      ))}
    </fieldset>
  )
}
function Toggle(p: {
  checked: boolean
  disabled?: boolean
  label: string
  change: (v: boolean) => void
}) {
  return (
    <label className="toggle">
      <input
        type="checkbox"
        checked={p.checked}
        disabled={p.disabled}
        onChange={(e) => p.change(e.target.checked)}
      />
      <span>{p.label}</span>
    </label>
  )
}
function Form(p: {
  className?: string
  topActions?: boolean
  actionControls?: ReactNode
  revert?: () => void
  disabled?: boolean
  go: (f: FormData) => Promise<void>
  submit: string
  submitIcon?: ReactNode
  resetOnSuccess?: boolean
  title?: string
  compact?: boolean
  cancel?: () => void
  children: ReactNode
}) {
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  return (
    <form
      noValidate={p.topActions}
      className={`action-form ${p.className ?? ''} ${p.compact ? 'compact' : ''} ${p.topActions ? 'top-actions' : ''}`}
      onSubmit={async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        if (submitting || p.disabled) return
        const form = e.currentTarget
        setSubmitting(true)
        setError('')
        try {
          await p.go(new FormData(form))
          if (p.resetOnSuccess !== false) form.reset()
        } catch (x) {
          setError(x instanceof Error ? x.message : 'Request failed')
        } finally {
          setSubmitting(false)
        }
      }}
    >
      {!p.topActions && (
        <>
          {p.title && <h2>{p.title}</h2>}
          {p.children}
        </>
      )}
      {p.topActions ? (
        <div className="form-actions">
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          {p.actionControls}
          <button
            type="button"
            className="secondary"
            disabled={submitting}
            onClick={p.revert}
          >
            Revert
          </button>
          <button className="primary" disabled={submitting || p.disabled}>
            {submitting ? 'Saving…' : p.submit}
          </button>
        </div>
      ) : (
        <>
          {p.cancel && (
            <button type="button" className="secondary" onClick={p.cancel}>
              Cancel
            </button>
          )}
          <button className="primary" disabled={submitting || p.disabled}>
            {submitting ? 'Saving…' : p.submit}
            {p.submitIcon !== null && (
              <b className="button-icon">
                {p.submitIcon ?? <UiIcon name="arrowRight" />}
              </b>
            )}
          </button>
          {error && <p className="error">{error}</p>}
        </>
      )}
      {p.topActions && (
        <div className="form-fields">
          {p.title && <h2>{p.title}</h2>}
          {p.children}
        </div>
      )}
    </form>
  )
}

function AddAccountIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M15 19a6 6 0 00-12 0M9 11a4 4 0 100-8 4 4 0 000 8M19 8v6M16 11h6" />
    </svg>
  )
}

function OAuthIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M10 17l5-5-5-5M15 12H3M14 4h5a2 2 0 012 2v12a2 2 0 01-2 2h-5" />
    </svg>
  )
}

function Modal(p: { title: string; close: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => ref.current?.showModal(), [])
  return (
    <dialog className="modal" ref={ref} onCancel={p.close}>
      <header>
        <h2>{p.title}</h2>
        <button
          aria-label="Close"
          className="secondary close-connection"
          onClick={p.close}
        >
          <UiIcon name="close" />
        </button>
      </header>
      {p.children}
    </dialog>
  )
}
async function act(action: string, body: Record<string, unknown> = {}) {
  const r = await fetch('/api/admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  })
  if (!r.ok) throw await responseError(r)
  return r.json().catch(() => ({}))
}
function human(x: string) {
  return x.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())
}

function useConnectionData(connectionId?: string) {
  const [control, setControl] = useState<ControlData>()
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let cancelled = false
    setError('')
    fetch(
      `/api/control${connectionId ? `?connection=${encodeURIComponent(connectionId)}` : ''}`,
    )
      .then(async (response) => {
        if (!response.ok) throw new Error('Could not load connection')
        return response.json()
      })
      .then((result) => {
        if (!cancelled) setControl(result)
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message)
      })
    return () => {
      cancelled = true
    }
  }, [connectionId, revision])
  return { control, error, reload: () => setRevision((value) => value + 1) }
}

export function AddConnectionPage({ data }: View) {
  const { control, error, reload } = useConnectionData()
  const [manual, setManual] = useState(false)
  const navigate = useNavigate()
  const canManage =
    data.authorization?.administrator ||
    data.authorization?.capabilities.includes('manage_connections')
  if (!canManage)
    return <p role="alert">Connection management access is required.</p>
  if (error) return <p role="alert">{error}</p>
  if (!control) return <p role="status">Loading registries…</p>
  const done = (connection: string) => {
    void navigate({ to: '/connections', search: { connection } })
  }
  return (
    <Page
      title="Add connection"
      actions={
        <>
          <Link
            className="secondary close-connection"
            to="/connections"
            aria-label="Close add connection"
            title="Close"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="m4 4 8 8M12 4l-8 8"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </Link>
        </>
      }
    >
      <div className="connection-picker">
        {manual ? (
          <>
            <button
              className="secondary choose-server"
              onClick={() => setManual(false)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 16 16"
                aria-hidden="true"
              >
                <path
                  d="M13 8H3m5-5L3 8l5 5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Choose a server
            </button>
            <ConnectionForm
              data={data}
              organizationId={control.organizationId!}
              done={done}
            />
          </>
        ) : (
          <RegistryPanel
            manual={() => setManual(true)}
            data={data}
            control={control}
            reload={reload}
            done={done}
          />
        )}
      </div>
    </Page>
  )
}

export function ConfigureConnectionPage({
  data,
  connectionId,
  tab,
}: View & { connectionId: string; tab: 'connection' | 'tools' }) {
  const { control, error, reload } = useConnectionData(connectionId)
  const [actionError, setActionError] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [editRevision, setEditRevision] = useState(0)
  const canManage =
    data.authorization?.administrator ||
    data.authorization?.capabilities.includes('manage_connections')
  if (!canManage)
    return <p role="alert">Connection management access is required.</p>
  if (error) return <p role="alert">{error}</p>
  if (!control) return <p role="status">Loading connection…</p>
  const d = control.detail
  if (!d) return <p role="alert">Connection not found.</p>
  const run = async (action: string, extra: Record<string, unknown> = {}) => {
    setBusy(true)
    setActionError('')
    try {
      await controlAct(action, { id: connectionId, ...extra })
      reload()
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Request failed')
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="configuration-page">
      <PageBar
        title={`Configure ${d.display_name}`}
        actions={
          <>
            <Status ok={d.state === 'enabled'}>
              {d.state === 'enabled' ? 'Enabled' : 'Disabled'}
            </Status>
            <Link
              className="secondary"
              to="/connections"
              search={{ connection: connectionId }}
            >
              <UiIcon name="arrowLeft" /> Back to Accounts
            </Link>
          </>
        }
      />
      <div className="config-tabs" aria-label="Configuration sections">
        <Link
          to="/connections/$connectionId/configure"
          params={{ connectionId }}
          search={{ tab: 'connection' }}
          aria-current={tab === 'connection' ? 'page' : undefined}
        >
          Connection config
        </Link>
        <Link
          to="/connections/$connectionId/configure"
          params={{ connectionId }}
          search={{ tab: 'tools' }}
          aria-current={tab === 'tools' ? 'page' : undefined}
        >
          Tools ({d.tools.length})
        </Link>
      </div>
      <div className="configuration-content">
        {actionError && (
          <p className="error" role="alert">
            {actionError}
          </p>
        )}
        <EditConnectionForm
          changed={() => {
            setDirty(true)
          }}
          actions={
            tab === 'tools' ? (
              <button
                type="button"
                className="secondary"
                disabled={busy || dirty}
                onClick={() => void run('refresh-connection')}
              >
                {busy ? 'Refreshing…' : 'Refresh tools'}
              </button>
            ) : (
              <button
                type="button"
                className="secondary"
                disabled={busy || dirty}
                onClick={() =>
                  void run('set-enabled', { enabled: d.state !== 'enabled' })
                }
              >
                {d.state === 'enabled' ? 'Disable' : 'Enable'}
              </button>
            )
          }
          key={`${d.id}:${d.revision}:${editRevision}`}
          detail={d}
          groups={data.groups ?? []}
          tab={tab}
          revert={() => {
            setEditRevision((value) => value + 1)
            setDirty(false)
          }}
          done={() => {
            setDirty(false)
            reload()
          }}
        />
        {tab === 'connection' &&
          (data.authorization?.administrator ||
            data.authorization?.capabilities.includes('manage_accounts')) &&
          d.transport === 'streamable_http' && (
            <details className="registry-sources">
              <summary>Advanced OAuth application</summary>
              <OAuthClientForm
                key={d.id}
                connectionId={d.id}
                configuration={d.oauth_application}
                done={reload}
              />
            </details>
          )}
      </div>
    </div>
  )
}
