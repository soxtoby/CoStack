import { useState } from 'react'
import { UiIcon } from './ui-icon'
import {
  evaluateToolPolicy,
  setToolPolicy,
  validateGlob,
} from '../connections/policy'
import type { ToolPolicy, ToolPolicyEffect } from '../connections/types'

const effects: Record<ToolPolicyEffect, string> = {
  block: 'Block',
  require_approval: 'Require approval',
  allow: 'Allow',
}

export function ToolPolicyEditor(p: {
  policies: Array<ToolPolicy>
  tools: Array<{ name: string; description?: string }>
  change: (policies: Array<ToolPolicy>) => void
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string>()
  const selectedTool = p.tools.find((tool) => tool.name === selected)
  let error = ''
  try {
    p.policies.forEach(({ pattern }) => validateGlob(pattern))
  } catch (e) {
    error = e instanceof Error ? e.message : 'Invalid pattern'
  }
  const tools = p.tools.filter((tool) =>
    `${tool.name} ${tool.description ?? ''}`
      .toLowerCase()
      .includes(search.toLowerCase()),
  )
  return (
    <section className="policy-editor" aria-label="Tool policies">
      <h2>Tool policies</h2>
      <p>
        Allow runs a tool immediately. Require approval asks before running it.
        Block prevents use. Changes apply when you save.
      </p>
      <label className="field">
        <span>Default for all tools, including newly discovered tools</span>
        <select
          value={
            p.policies.find(({ pattern }) => pattern === '*')?.effect ?? 'block'
          }
          onChange={(e) =>
            p.change([
              ...p.policies.filter(({ pattern }) => pattern !== '*'),
              { pattern: '*', effect: e.target.value as ToolPolicyEffect },
            ])
          }
        >
          {Object.entries(effects).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <section className="policy-definitions" aria-label="Policy definitions">
        <div className="toolbar">
          <h3>
            Pattern rules (
            {p.policies.filter(({ pattern }) => pattern !== '*').length})
          </h3>
          <button
            type="button"
            className="secondary"
            onClick={() =>
              p.change([...p.policies, { pattern: '', effect: 'block' }])
            }
          >
            Add pattern rule
          </button>
        </div>
        <p>
          Use an exact tool name, <code>*</code> for any number of characters,
          or <code>?</code> for one character. For example, <code>read_*</code>{' '}
          matches names starting with <code>read_</code>. Patterns are
          case-sensitive; brackets and braces are not supported.
        </p>
        <p>
          The rule with the most non-wildcard characters wins. Ties prefer
          Block, then Require approval, then Allow. Tools with no matching rule
          are blocked. The tool list shows the result, and setting a tool's
          action there adds a rule for that exact name, or removes it when the
          rules already give that action.
        </p>
        {p.policies.every(({ pattern }) => pattern === '*') && (
          <p>No pattern rules. All tools use the default action.</p>
        )}
        {p.policies.map((rule, index) =>
          rule.pattern === '*' ? null : (
            <div className="policy-rule" key={index}>
              <label className="field">
                <span>Tool name or pattern</span>
                <input
                  required
                  value={rule.pattern}
                  placeholder="read_*"
                  onChange={(e) =>
                    p.change(
                      p.policies.map((current, i) =>
                        i === index
                          ? { ...current, pattern: e.target.value }
                          : current,
                      ),
                    )
                  }
                />
              </label>
              <label className="field">
                <span>Action</span>
                <select
                  value={rule.effect}
                  onChange={(e) =>
                    p.change(
                      p.policies.map((current, i) =>
                        i === index
                          ? {
                              ...current,
                              effect: e.target.value as ToolPolicyEffect,
                            }
                          : current,
                      ),
                    )
                  }
                >
                  {Object.entries(effects).map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="secondary"
                aria-label={`Remove rule ${rule.pattern || index + 1}`}
                onClick={() =>
                  p.change(p.policies.filter((_, i) => i !== index))
                }
              >
                Remove
              </button>
            </div>
          ),
        )}
      </section>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <h3>Discovered tools ({p.tools.length})</h3>
      {!error && (
        <p className="policy-summary" aria-live="polite">
          {Object.entries(effects)
            .map(
              ([effect, label]) =>
                `${p.tools.filter((tool) => evaluateToolPolicy(p.policies, tool.name) === effect).length} ${label.toLowerCase()}`,
            )
            .join(' · ')}
        </p>
      )}
      {p.tools.length === 0 ? (
        <p>
          No tools discovered yet. If this server requires authentication,
          configure an Account on the connections page, then choose Refresh
          tools. You can keep all tools blocked until discovery succeeds.
        </p>
      ) : (
        <>
          <label className="field">
            <span>Find a tool</span>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search names and descriptions"
            />
          </label>
          <div
            className={`tool-browser ${selectedTool ? 'has-selection' : ''}`}
          >
            <div className="policy-tools" aria-label="Discovered tools">
              {tools.map((tool) => {
                return (
                  <article
                    key={tool.name}
                    className={selected === tool.name ? 'selected' : ''}
                  >
                    <button
                      type="button"
                      className="tool-select"
                      aria-expanded={selected === tool.name}
                      onClick={() =>
                        setSelected(
                          selected === tool.name ? undefined : tool.name,
                        )
                      }
                    >
                      <b>{tool.name}</b>
                      <span>
                        {tool.description?.replace(/\s+/g, ' ').slice(0, 100) ||
                          'No description provided.'}
                      </span>
                    </button>
                    <label className="field">
                      <select
                        aria-label={`Action for ${tool.name}`}
                        disabled={Boolean(error)}
                        value={
                          error ? '' : evaluateToolPolicy(p.policies, tool.name)
                        }
                        onChange={(e) =>
                          p.change(
                            setToolPolicy(
                              p.policies,
                              tool.name,
                              e.target.value as ToolPolicyEffect,
                            ),
                          )
                        }
                      >
                        {error && (
                          <option value="">Fix invalid patterns</option>
                        )}
                        {Object.entries(effects).map(([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </article>
                )
              })}
            </div>
            {selectedTool && (
              <aside
                className="tool-description"
                aria-label={`Description of ${selectedTool.name}`}
              >
                <div className="toolbar">
                  <b>{selectedTool.name}</b>
                  <button
                    type="button"
                    className="secondary"
                    aria-label="Close tool description"
                    onClick={() => setSelected(undefined)}
                  >
                    <UiIcon name="close" />
                  </button>
                </div>
                <p>{selectedTool.description || 'No description provided.'}</p>
              </aside>
            )}
          </div>
          {tools.length === 0 && <p>No tools match this search.</p>}
        </>
      )}
    </section>
  )
}
