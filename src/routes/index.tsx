import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { ConnectionInput } from '../connections/types'
import type { RegistryServer } from '../connections/registry'

export const Route = createFileRoute('/')({ component: App })
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
  state: 'bootstrap' | 'login' | 'ready'
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
  providers?: Array<{ provider_id: string; domain: string; issuer: string }>
  capabilityOptions?: Array<string>
}
type View = { data: Data; reload: () => void }

function App() {
  const [data, setData] = useState<Data>()
  const [page, setPage] = useState('overview')
  const reload = () =>
    fetch('/api/admin').then(async (r) => setData(await r.json()))
  useEffect(() => void reload(), [])
  if (!data) return <div className="loading">Checking gateway state</div>
  if (data.state === 'bootstrap') return <Bootstrap done={reload} />
  if (data.state === 'login') return <Login providerId={data.loginProviderId} />
  const manage =
    data.authorization?.administrator ||
    data.authorization?.capabilities.includes('manage_principals_groups')
  const links = [
    ['overview', 'Overview'],
    ['connections', 'MCP Connections'],
    ['preferences', 'Preferences'],
    ...(data.authorization?.administrator ||
    data.authorization?.capabilities.includes('view_audit')
      ? [['audit', 'Audit']]
      : []),
    ...(manage
      ? [
          ['users', 'Users'],
          ['access', 'Pre-provisioned access'],
          ['groups', 'Groups'],
          ['services', 'Service Accounts'],
        ]
      : []),
    ...(data.authorization?.administrator ||
    data.authorization?.capabilities.includes('manage_sso')
      ? [['sso', 'SSO']]
      : []),
  ]
  return (
    <div className="app">
      <aside>
        <Logo />
        <div className="online">
          <i /> Gateway online
        </div>
        <nav>
          {links.map(([id, label], i) => (
            <button
              className={page === id ? 'active' : ''}
              aria-current={page === id ? 'page' : undefined}
              onClick={() => setPage(id!)}
              key={id}
            >
              <code>{String(i + 1).padStart(2, '0')}</code>
              {label}
            </button>
          ))}
        </nav>
        <footer>
          <b>{data.me?.name}</b>
          <small>
            {data.authorization?.administrator ? 'Administrator' : 'Operator'}
          </small>
          <button
            aria-label="Sign out"
            title="Sign out"
            onClick={() => act('sign-out').then(() => location.reload())}
          >
            ↗
          </button>
        </footer>
      </aside>
      <main>
        <header>
          {data.organization?.display_name}
          <code>CONTROL / {page.toUpperCase()}</code>
        </header>
        {page === 'overview' && <Overview data={data} />}{' '}
        {page === 'connections' && <Connections data={data} />}{' '}
        {page === 'preferences' && <Preferences />}{' '}
        {page === 'audit' && <Audit />}{' '}
        {page === 'users' && <Users data={data} reload={reload} />}{' '}
        {page === 'access' && <Access data={data} reload={reload} />}{' '}
        {page === 'groups' && <Groups data={data} reload={reload} />}{' '}
        {page === 'services' && <Services data={data} reload={reload} />}{' '}
        {page === 'sso' && <Sso data={data} reload={reload} />}
      </main>
    </div>
  )
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
    has_oauth: boolean
    error?: string
    policies: Array<{ pattern: string; effect: string }>
    tools: Array<{ name: string; description?: string; policy: string }>
    accounts: Array<{
      id: string
      kind: 'shared' | 'personal'
      owner_user_id?: string
      display_name: string
      namespace: string
      has_secret: boolean
    }>
  }
}

function Connections({ data }: { data: Data }) {
  const [control, setControl] = useState<ControlData>()
  const [selected, setSelected] = useState<string>()
  const [creating, setCreating] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const load = async (id = selected) => {
    const r = await fetch(
      `/api/control${id ? `?connection=${encodeURIComponent(id)}` : ''}`,
    )
    if (r.ok) setControl(await r.json())
  }
  useEffect(() => void load(), [selected])
  const canConnections =
    data.authorization?.administrator ||
    data.authorization?.capabilities.includes('manage_connections')
  const canAccounts =
    data.authorization?.administrator ||
    data.authorization?.capabilities.includes('manage_accounts')
  if (!control) return <div className="loading">Loading MCP Connections</div>
  return (
    <Page
      eyebrow="Gateway routing"
      title="MCP Connections"
      intro="Browse the registry to add an MCP server, or configure a connection manually."
    >
      <div className="toolbar">
        <span>{control.connections.length} configured</span>
        {canConnections && (
          <div className="detail-actions">
            <button
              className="primary"
              aria-expanded={browsing}
              onClick={() => {
                setBrowsing(!browsing)
                setCreating(false)
              }}
            >
              {browsing ? 'Close registry' : 'Browse registry'}
            </button>
            <button
              className="secondary"
              aria-expanded={creating}
              onClick={() => {
                setCreating(!creating)
                setBrowsing(false)
              }}
            >
              {creating ? 'Cancel' : 'Add manually'}
            </button>
          </div>
        )}
      </div>
      {browsing && canConnections && (
        <RegistryPanel
          data={data}
          control={control}
          reload={() => load()}
          done={(id) => {
            setBrowsing(false)
            setSelected(id)
          }}
        />
      )}
      {creating && (
        <ConnectionForm
          data={data}
          organizationId={control.organizationId!}
          done={(id) => {
            setCreating(false)
            setSelected(id)
          }}
        />
      )}
      <div className="connection-grid">
        <div className="connection-list">
          {control.connections.map((c) => (
            <button
              key={c.id}
              className={selected === c.id ? 'selected' : ''}
              onClick={() => setSelected(c.id)}
            >
              <Status ok={c.healthy !== false}>{c.state}</Status>
              <b>{c.display_name}</b>
              <code>{c.namespace}__*</code>
            </button>
          ))}
        </div>
        <section className="connection-detail">
          {!control.detail ? (
            <div className="empty">
              <code>NO CONNECTION SELECTED</code>
              <p>Choose a Connection to inspect its tools and Accounts.</p>
            </div>
          ) : (
            <ConnectionDetail
              detail={control.detail}
              canConnections={Boolean(canConnections)}
              canAccounts={Boolean(canAccounts)}
              reload={() => load(control.detail!.id)}
            />
          )}
        </section>
      </div>
    </Page>
  )
}

function ConnectionForm(p: {
  data: Data
  organizationId: string
  initial?: ConnectionInput
  done: (id: string) => void
}) {
  const [kind, setKind] = useState<'streamable_http' | 'stdio'>(
    p.initial?.transport.kind ?? 'streamable_http',
  )
  return (
    <Form
      title={p.initial ? 'Review connection' : 'New MCP Connection'}
      submit="Validate and save"
      go={async (f) => {
        const policies = parsePolicies(String(f.get('policies') || '* = block'))
        const transport =
          kind === 'streamable_http'
            ? { kind, url: String(f.get('url')) }
            : {
                kind,
                command: String(f.get('command')),
                args: p.initial
                  ? JSON.parse(String(f.get('args') || '[]'))
                  : String(f.get('args') || '')
                      .split(/\s+/)
                      .filter(Boolean),
              }
        if (
          transport.kind === 'stdio' &&
          (!Array.isArray(transport.args) ||
            !transport.args.every((arg: unknown) => typeof arg === 'string'))
        ) {
          throw new Error('Arguments must be a JSON array of strings.')
        }
        const result = await controlAct('create-connection', {
          input: {
            organizationId: p.organizationId,
            displayName: String(f.get('displayName')),
            namespace: String(f.get('namespace') || '') || undefined,
            transport,
            state: 'disabled',
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
            defaultValue={p.initial?.displayName}
          />
        </Field>
        <Field label="Namespace, fixed after save">
          <input name="namespace" placeholder="derived_from_name" />
        </Field>
      </div>
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
            defaultValue={
              p.initial?.transport.kind === 'streamable_http'
                ? p.initial.transport.url
                : undefined
            }
          />
        </Field>
      ) : (
        <div className="form-grid">
          <Field label="Command">
            <input
              name="command"
              required
              placeholder="bunx or dotnet"
              defaultValue={
                p.initial?.transport.kind === 'stdio'
                  ? p.initial.transport.command
                  : undefined
              }
            />
          </Field>
          <Field label={p.initial ? 'Arguments (JSON array)' : 'Arguments'}>
            <input
              name="args"
              placeholder={
                p.initial ? '["@scope/server@1.2.3"]' : '@scope/server@1.2.3'
              }
              defaultValue={
                p.initial?.transport.kind === 'stdio'
                  ? JSON.stringify(p.initial.transport.args ?? [])
                  : undefined
              }
            />
          </Field>
        </div>
      )}
      <GroupChecks groups={p.data.groups ?? []} />
      <Field label="Tool policies, one pattern = effect per line">
        <textarea
          name="policies"
          defaultValue={
            p.initial
              ? p.initial.policies
                  .map((policy) => `${policy.pattern} = ${policy.effect}`)
                  .join('\n')
              : '* = block\nread_* = allow'
          }
        />
      </Field>
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
  const [editing, setEditing] = useState(false)
  const [credentials, setCredentials] = useState<string>()
  return (
    <>
      <header className="detail-head">
        <div>
          <code>
            {d.namespace} / REV {d.revision}
          </code>
          <h2>{d.display_name}</h2>
        </div>
        <Status ok={d.state === 'enabled'}>{d.state}</Status>
      </header>
      {d.error && <p className="error">{d.error}</p>}
      <div className="detail-actions">
        {p.canConnections && (
          <>
            <button className="secondary" onClick={() => setEditing(!editing)}>
              {editing ? 'Close editor' : 'Edit'}
            </button>
            <button
              className="secondary"
              onClick={() =>
                controlAct('refresh-connection', { id: d.id }).then(p.reload)
              }
            >
              Refresh tools
            </button>
            <button
              className="secondary"
              onClick={() =>
                controlAct('set-enabled', {
                  id: d.id,
                  enabled: d.state !== 'enabled',
                }).then(p.reload)
              }
            >
              {d.state === 'enabled' ? 'Disable' : 'Enable'}
            </button>
            <button
              className="secondary"
              onClick={() => {
                const name = prompt('Clone display name')
                if (name)
                  controlAct('clone-connection', {
                    id: d.id,
                    displayName: name,
                  }).then(p.reload)
              }}
            >
              Clone
            </button>
          </>
        )}
      </div>
      {editing && (
        <EditConnectionForm
          detail={d}
          done={() => {
            setEditing(false)
            p.reload()
          }}
        />
      )}
      <h3>Tool policy map</h3>
      <div className="policy-map">
        {d.policies.map((x) => (
          <span key={x.pattern} className={`policy ${x.effect}`}>
            <code>{x.pattern}</code>
            {human(x.effect)}
          </span>
        ))}
      </div>
      <h3>Matched tools</h3>
      <div className="tool-table">
        {d.tools.map((t) => (
          <div key={t.name}>
            <code>{t.name}</code>
            <span>{t.description || 'No description'}</span>
            <b className={`policy ${t.policy}`}>{human(t.policy)}</b>
          </div>
        ))}
      </div>
      <h3>Accounts</h3>
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
              Credentials
            </button>
            {d.has_oauth && (
              <button
                className="secondary"
                onClick={async () => {
                  const result = await upstreamOAuthStart(a.id)
                  location.assign(result.authorizationUrl)
                }}
              >
                Connect OAuth
              </button>
            )}
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
        <CredentialForm
          account={d.accounts.find((a) => a.id === credentials)!}
          done={() => {
            setCredentials(undefined)
            p.reload()
          }}
        />
      )}
      <AccountForm connectionId={d.id} shared={p.canAccounts} done={p.reload} />
      {p.canAccounts && d.transport === 'streamable_http' && (
        <OAuthClientForm connectionId={d.id} done={p.reload} />
      )}
    </>
  )
}

function EditConnectionForm(p: {
  detail: NonNullable<ControlData['detail']>
  done: () => void
}) {
  const d = p.detail
  const transport = d.transport_config
  const http = transport.kind === 'streamable_http'
  return (
    <Form
      compact
      title="Edit Connection"
      submit="Validate and save"
      go={async (f) => {
        const input = {
          organizationId: '',
          displayName: String(f.get('displayName')),
          transport: http
            ? { kind: 'streamable_http', url: String(f.get('url')) }
            : {
                kind: 'stdio',
                command: String(f.get('command')),
                args: String(f.get('args') || '')
                  .split(/\s+/)
                  .filter(Boolean),
              },
          state: d.state,
          groupIds: d.group_ids ?? [],
          policies: parsePolicies(String(f.get('policies'))),
        }
        await controlAct('edit-connection', {
          id: d.id,
          revision: d.revision,
          input,
        })
        p.done()
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
        <>
          <Field label="Command">
            <input
              name="command"
              defaultValue={String(transport.command ?? '')}
              required
            />
          </Field>
          <Field label="Arguments">
            <input
              name="args"
              defaultValue={
                Array.isArray(transport.args) ? transport.args.join(' ') : ''
              }
            />
          </Field>
        </>
      )}
      <Field label="Tool policies">
        <textarea
          name="policies"
          defaultValue={d.policies
            .map((x) => `${x.pattern} = ${x.effect}`)
            .join('\n')}
        />
      </Field>
      <p className="fine">
        Group access remains unchanged. A stale revision is rejected so another
        administrator's edit is not lost.
      </p>
    </Form>
  )
}

function CredentialForm(p: {
  account: NonNullable<ControlData['detail']>['accounts'][number]
  done: () => void
}) {
  const prefix = p.account.kind === 'shared' ? 'shared' : 'personal'
  return (
    <Form
      compact
      title={`Credentials for ${p.account.display_name}`}
      submit="Replace credentials"
      go={async (f) => {
        await controlAct(`replace-${prefix}-secret`, {
          id: p.account.id,
          secrets: JSON.parse(String(f.get('secrets') || '{}')),
        })
        p.done()
      }}
    >
      <Field label="Credential fields as JSON">
        <textarea name="secrets" defaultValue="{}" spellCheck={false} />
      </Field>
      {p.account.has_secret && (
        <button
          type="button"
          className="danger"
          onClick={() =>
            controlAct(`delete-${prefix}-secret`, { id: p.account.id }).then(
              p.done,
            )
          }
        >
          Clear saved credentials
        </button>
      )}
    </Form>
  )
}

function OAuthClientForm(p: { connectionId: string; done: () => void }) {
  return (
    <Form
      compact
      title="Upstream OAuth application"
      submit="Save OAuth application"
      go={async (f) => {
        await controlAct('configure-upstream-oauth', {
          connectionId: p.connectionId,
          config: {
            clientId: String(f.get('clientId')),
            clientSecret: String(f.get('clientSecret')),
            scope: String(f.get('scope') || '') || undefined,
          },
        })
        p.done()
      }}
    >
      <Field label="Client ID">
        <input name="clientId" required />
      </Field>
      <Field label="Client secret">
        <input name="clientSecret" type="password" required />
      </Field>
      <Field label="Scopes">
        <input name="scope" placeholder="openid profile" />
      </Field>
    </Form>
  )
}

function AccountForm(p: {
  connectionId: string
  shared: boolean
  done: () => void
}) {
  const [kind, setKind] = useState<'personal' | 'shared'>('personal')
  return (
    <Form
      compact
      submit="Add Account"
      go={async (f) => {
        const secrets = JSON.parse(String(f.get('secrets') || '{}'))
        await controlAct(
          kind === 'shared'
            ? 'create-shared-account'
            : 'create-personal-account',
          {
            connectionId: p.connectionId,
            displayName: String(f.get('displayName')),
            secrets,
          },
        )
        p.done()
      }}
    >
      <Field label="Account display name">
        <input name="displayName" required />
      </Field>
      {p.shared && (
        <div className="segmented">
          <button
            type="button"
            className={kind === 'personal' ? 'on' : ''}
            onClick={() => setKind('personal')}
          >
            Personal
          </button>
          <button
            type="button"
            className={kind === 'shared' ? 'on' : ''}
            onClick={() => setKind('shared')}
          >
            Shared
          </button>
        </div>
      )}
      <Field label="Credential fields as JSON">
        <textarea name="secrets" defaultValue="{}" spellCheck={false} />
      </Field>
    </Form>
  )
}

function RegistryPanel(p: {
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
  const [search, setSearch] = useState('')
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
    controlAct('browse-registry', { sourceId, search, cursor })
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
    return () => {
      cancelled = true
    }
  }, [sourceId, search, cursor, retry])
  if (prefill)
    return (
      <section className="registry">
        <button className="secondary" onClick={() => setPrefill(undefined)}>
          Back to registry
        </button>
        <p>
          <b>{prefill.registry?.serverId}</b> · Version{' '}
          {prefill.registry?.version}
        </p>
        <p>
          Review the settings, then save. New connections start disabled with
          tools blocked. After saving, configure Accounts and Tool Policies,
          then enable the connection.
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
      <h2>Browse MCP registry</h2>
      <p>
        Search by part of a server name, or browse the list. Select a server to
        review its connection settings.
      </p>
      <form
        className="registry-search"
        onSubmit={(e) => {
          e.preventDefault()
          setResults([])
          setCursor(undefined)
          setSearch(query)
          setRetry((value) => value + 1)
        }}
      >
        <Field label="Registry">
          <select
            value={sourceId}
            disabled={importing}
            onChange={(e) => {
              setSourceId(e.target.value)
              setCursor(undefined)
              setResults([])
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
            onChange={(e) => setQuery(e.target.value)}
            placeholder="e.g. github or filesystem"
          />
        </Field>
        <button className="primary" disabled={loading || importing}>
          Search
        </button>
      </form>
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
        {results.map(({ server }) => (
          <article key={`${server.name}:${server.version}`}>
            <div>
              <b>{server.name}</b>
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
      {!loading && !error && results.length === 0 && (
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
function Preferences() {
  const [data, setData] = useState<ControlData>()
  useEffect(
    () =>
      void fetch('/api/control')
        .then((r) => r.json())
        .then(setData),
    [],
  )
  if (!data) return null
  return (
    <Page
      eyebrow="Personal settings"
      title="Approval Method"
      intro="Choose how approval-required tools ask before execution."
    >
      <div className="choice-grid">
        {(['gateway_enforced', 'client_managed'] as const).map((method) => (
          <button
            className={data.approvalMethod === method ? 'chosen' : ''}
            key={method}
            onClick={() =>
              controlAct('set-approval-method', { method }).then(() =>
                setData({ ...data, approvalMethod: method }),
              )
            }
          >
            <code>{human(method)}</code>
            <p>
              {method === 'gateway_enforced'
                ? 'The gateway verifies approval through MCP input_required.'
                : 'Trust the MCP Client to prompt before it calls the marked tool.'}
            </p>
          </button>
        ))}
      </div>
    </Page>
  )
}

function Audit() {
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
      eyebrow="Accountability"
      title="Audit"
      intro="Metadata only. CoStack never stores tool arguments or results."
    >
      <div className="toolbar">
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
        <a
          className="primary"
          href={`/api/control?download=audit${query ? `&${query}` : ''}`}
        >
          Download JSONL <b>↓</b>
        </a>
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

function parsePolicies(value: string) {
  return value
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [pattern, effect] = line.split('=').map((x) => x.trim())
      return { pattern, effect }
    })
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
function Overview({ data }: { data: Data }) {
  return (
    <Page
      eyebrow="System overview"
      title="Identity control"
      intro="People and services with access to this gateway."
    >
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
              ? `${data.providers[0]!.domain} identities may sign in.`
              : 'Configure OIDC before onboarding users.'}
          </p>
        </div>
      </section>
    </Page>
  )
}
function Users({ data, reload }: View) {
  return (
    <Page
      eyebrow="Human principals"
      title="Users"
      intro="Identity comes from Better Auth. CoStack controls status and Groups."
    >
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
    </Page>
  )
}
function Access({ data, reload }: View) {
  return (
    <Page
      eyebrow="Before first sign-in"
      title="Pre-provisioned access"
      intro="Prepare Group membership for a verified SSO email. Records expire after seven days."
    >
      <Form
        submit="Prepare access"
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
                onClick={() => act('revoke-access', { id: x.id }).then(reload)}
              >
                Revoke
              </button>
            )}
          </article>
        ))}
      </Rows>
    </Page>
  )
}
function Groups({ data, reload }: View) {
  const [selected, setSelected] = useState(data.groups?.[0]?.id)
  const group = data.groups?.find((g) => g.id === selected)
  const principals = [...(data.users ?? []), ...(data.serviceAccounts ?? [])]
  return (
    <Page
      eyebrow="Local authorization"
      title="Groups"
      intro="Groups assign Capabilities and MCP Connection access."
    >
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
function Services({ data, reload }: View) {
  const [credential, setCredential] = useState<{
    clientId: string
    clientSecret: string
  }>()
  return (
    <Page
      eyebrow="Non-human principals"
      title="Service Accounts"
      intro="Credentials appear once. Store them before leaving this page."
    >
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
function Sso({ data, reload }: View) {
  const p = data.providers?.[0]
  return (
    <Page
      eyebrow="OIDC provider"
      title="Single sign-on"
      intro="Better Auth owns discovery, callbacks, and sessions."
    >
      <Form
        submit={p ? 'Update provider' : 'Connect provider'}
        go={async (f) => {
          await act('save-sso', Object.fromEntries(f))
          reload()
        }}
      >
        <div className="form-grid">
          <Field label="Provider ID">
            <input
              name="providerId"
              required
              defaultValue={p?.provider_id}
              disabled={!!p}
              placeholder="company"
            />
          </Field>
          <Field label="Email domain">
            <input
              name="domain"
              required
              defaultValue={p?.domain}
              placeholder="company.com"
            />
          </Field>
          <Field label="Issuer URL">
            <input name="issuer" type="url" required defaultValue={p?.issuer} />
          </Field>
          <Field label="Client ID">
            <input name="clientId" required />
          </Field>
          <Field label="Client secret">
            <input name="clientSecret" type="password" required />
          </Field>
        </div>
      </Form>
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
        <Field label="Administrator name">
          <input name="administratorName" required />
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
              body: JSON.stringify({ callbackURL: '/', providerId }),
            })
            const d = await r.json()
            if (d.url) location.href = d.url
            else setError('SSO is not configured')
          }}
        >
          Continue with SSO <b>→</b>
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
            if (r.ok) location.href = '/'
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
function Page(p: {
  eyebrow: string
  title: string
  intro: string
  children: ReactNode
}) {
  return (
    <div className="page">
      <section className="heading">
        <code>{p.eyebrow}</code>
        <h1>{p.title}</h1>
        <p>{p.intro}</p>
      </section>
      {p.children}
    </div>
  )
}
function Logo() {
  return (
    <a className="logo" href="/">
      <i>C</i>
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
function GroupChecks({ groups }: { groups: Array<Group> }) {
  return (
    <fieldset>
      <legend>Initial Groups</legend>
      {groups.map((g) => (
        <label className="check" key={g.id}>
          <input name="groups" value={g.id} type="checkbox" />
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
  go: (f: FormData) => Promise<void>
  submit: string
  title?: string
  compact?: boolean
  children: ReactNode
}) {
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  return (
    <form
      className={`action-form ${p.compact ? 'compact' : ''}`}
      onSubmit={async (e: FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        if (submitting) return
        const form = e.currentTarget
        setSubmitting(true)
        setError('')
        try {
          await p.go(new FormData(form))
          form.reset()
        } catch (x) {
          setError(x instanceof Error ? x.message : 'Request failed')
        } finally {
          setSubmitting(false)
        }
      }}
    >
      {p.title && <h2>{p.title}</h2>}
      {p.children}
      <button className="primary" disabled={submitting}>
        {submitting ? 'Saving…' : p.submit}
        <b>→</b>
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
async function act(action: string, body: Record<string, unknown> = {}) {
  const r = await fetch('/api/admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action, ...body }),
  })
  const d = await r.json().catch(() => ({}))
  if (!r.ok) throw Error(d.error ?? 'Request failed')
  return d
}
function human(x: string) {
  return x.replaceAll('_', ' ').replace(/^./, (c) => c.toUpperCase())
}
