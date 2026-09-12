import { createFileRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import { UiIcon } from '../../components/ui-icon'

export const Route = createFileRoute('/oauth/consent')({ component: Consent })
function Consent() {
  const q = new URLSearchParams(
    typeof location === 'undefined' ? '' : location.search,
  )
  const [busy, setBusy] = useState(false)
  const [clientName, setClientName] = useState<string>()
  const clientId = q.get('client_id')
  useEffect(() => {
    if (!clientId) return
    void loadOAuthClientName(clientId).then(setClientName, () =>
      setClientName(undefined),
    )
  }, [clientId])
  async function decide(accept: boolean) {
    setBusy(true)
    const r = await fetch('/api/auth/oauth2/consent', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accept, oauth_query: location.search.slice(1) }),
    })
    const d = await r.json()
    if (d.redirect_uri || d.url) location.href = d.redirect_uri ?? d.url
    else setBusy(false)
  }
  return (
    <main className="consent">
      <section>
        <div className="logo">
          <i>C</i>
          <b>CoStack</b>
        </div>
        <code>MCP AUTHORIZATION</code>
        <h1>Open the gateway?</h1>
        <p>
          <b>{clientName ?? 'An MCP Client'}</b> is requesting access on your
          behalf.
        </p>
        <div className="scope">
          <b>
            <UiIcon name="check" /> Use approved MCP tools
          </b>
          <small>
            Access still follows your current Groups and Tool Policies.
          </small>
        </div>
        <p className="fine">
          CoStack never gives this client your upstream Account secrets.
        </p>
        <footer>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => decide(false)}
          >
            Deny
          </button>
          <button
            className="primary"
            disabled={busy}
            onClick={() => decide(true)}
          >
            Allow access <UiIcon name="check" />
          </button>
        </footer>
      </section>
    </main>
  )
}

export async function loadOAuthClientName(
  clientId: string,
  request: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response> = fetch,
) {
  const response = await request(
    `/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`,
  )
  if (!response.ok) return undefined
  const client = (await response.json()) as { client_name?: unknown }
  return typeof client.client_name === 'string' && client.client_name.trim()
    ? client.client_name
    : undefined
}
