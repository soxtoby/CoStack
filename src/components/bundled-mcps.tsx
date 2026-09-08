import { bundledMcps } from '../connections/bundled-mcps'
import { McpIcon } from './mcp-icon'
import type { BundledMcp } from '../connections/bundled-mcps'

export function BundledMcpCards({
  select,
}: {
  select: (entry: BundledMcp) => void
}) {
  return (
    <section aria-label="Bundled MCPs">
      <h3>Bundled MCPs</h3>
      <div className="bundled-cards">
        {bundledMcps.map((entry) => (
          <article key={entry.id}>
            <div>
              <div className="bundled-card-title">
                <McpIcon src={entry.icon} name={entry.displayName} />
                <b>{entry.displayName}</b>
              </div>
              {entry.transport.kind === 'streamable_http' && (
                <small>
                  <code>{entry.transport.url}</code>
                </small>
              )}
              <p>{entry.description}</p>
            </div>
            <footer>
              <a href={entry.documentationUrl} target="_blank" rel="noreferrer">
                Documentation
              </a>
              <button
                className="primary"
                aria-label={`Add ${entry.displayName}`}
                onClick={() => select(entry)}
              >
                Add
              </button>
            </footer>
          </article>
        ))}
      </div>
    </section>
  )
}

export function BundledMcpSetup({ entry }: { entry: BundledMcp | undefined }) {
  if (!entry) return null
  return (
    <div className="note">
      <b>{entry.displayName} setup</b>
      <p>{entry.setup}</p>
      <a href={entry.documentationUrl} target="_blank" rel="noreferrer">
        Vendor documentation
      </a>
    </div>
  )
}
