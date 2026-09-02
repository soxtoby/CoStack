import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

export const Route = createFileRoute('/oauth/consent')({ component: Consent })
function Consent() {
  const q = new URLSearchParams(
    typeof location === 'undefined' ? '' : location.search,
  )
  const [busy, setBusy] = useState(false)
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
          <b>{q.get('client_name') ?? 'An MCP Client'}</b> is requesting access
          on your behalf.
        </p>
        <div className="scope">
          <b>✓ &nbsp; Use approved MCP tools</b>
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
            Allow access →
          </button>
        </footer>
      </section>
    </main>
  )
}
