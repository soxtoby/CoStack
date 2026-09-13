import { useState } from 'react'
import {
  annotationLabels,
  evaluateToolPolicy,
  resolveToolPolicy,
  setToolPolicy,
  validateToolPolicy,
} from '../connections/policy'
import { UiIcon } from './ui-icon'
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type {
  ToolPolicy,
  ToolPolicyAnnotation,
  ToolPolicyEffect,
} from '../connections/types'

const effects: Record<ToolPolicyEffect, string> = {
  block: 'Block',
  require_approval: 'Require approval',
  allow: 'Allow',
}

export function ToolPolicyEditor(p: {
  policies: Array<ToolPolicy>
  tools: Array<{
    name: string
    description?: string
    annotations?: ToolAnnotations
  }>
  change: (policies: Array<ToolPolicy>) => void
}) {
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string>()
  const selectedTool = p.tools.find((tool) => tool.name === selected)
  let error = ''
  try {
    p.policies.forEach(validateToolPolicy)
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
      <section className="policy-definitions" aria-label="Annotation rules">
        <h3>Annotation rules</h3>
        <div className="policy-annotation-rules">
          {Object.entries(annotationLabels).map(([key, label]) => (
            <label className="field" key={key}>
              <span>{label}</span>
              <select
                aria-label={label + ' rule'}
                value={
                  p.policies.find((rule) => rule.annotation === key)?.effect ??
                  ''
                }
                onChange={(event) => {
                  const others = p.policies.filter(
                    (rule) => rule.annotation !== key,
                  )
                  p.change(
                    event.target.value
                      ? [
                          ...others,
                          {
                            annotation: key as ToolPolicyAnnotation,
                            effect: event.target.value as ToolPolicyEffect,
                          },
                        ]
                      : others,
                  )
                }}
              >
                <option value="">No rule</option>
                {Object.entries(effects).map(([value, text]) => (
                  <option key={value} value={value}>
                    {text}
                  </option>
                ))}
              </select>
            </label>
          ))}
        </div>
        <p>
          Destructive excludes read-only tools. Missing annotations count as
          potentially destructive and open-world. These rules rely on the
          upstream server's annotations.
        </p>
      </section>
      <section className="policy-definitions" aria-label="Policy definitions">
        <div className="toolbar">
          <h3>
            Pattern rules (
            {
              p.policies.filter(
                (rule) => rule.pattern !== undefined && rule.pattern !== '*',
              ).length
            }
            )
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
          Exact tool overrides win, then name patterns, then annotation rules,
          then the default. Among patterns, the most non-wildcard characters
          wins. Ties prefer Block, then Require approval, then Allow. Tools with
          no matching rule are blocked. The tool list shows the result, and
          setting a tool's action there adds a rule for that exact name, or
          removes it when the rules already give that action.
        </p>
        {p.policies.every(
          (rule) => rule.pattern === undefined || rule.pattern === '*',
        ) && (
          <p>
            No pattern rules. Annotation rules and the default action apply.
          </p>
        )}
        {p.policies.map((rule, index) =>
          rule.pattern === undefined || rule.pattern === '*' ? null : (
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
                          ? { effect: current.effect, pattern: e.target.value }
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
                `${p.tools.filter((tool) => evaluateToolPolicy(p.policies, tool.name, tool.annotations) === effect).length} ${label.toLowerCase()}`,
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
          <div className="tool-browser has-selection">
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
                          error
                            ? ''
                            : evaluateToolPolicy(
                                p.policies,
                                tool.name,
                                tool.annotations,
                              )
                        }
                        onChange={(e) =>
                          p.change(
                            setToolPolicy(
                              p.policies,
                              tool.name,
                              e.target.value as ToolPolicyEffect,
                              tool.annotations,
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
                      {!error && (
                        <small>
                          {
                            resolveToolPolicy(
                              p.policies,
                              tool.name,
                              tool.annotations,
                            ).source
                          }
                        </small>
                      )}
                    </label>
                  </article>
                )
              })}
            </div>
            <aside
              className="tool-description"
              aria-label={
                selectedTool
                  ? `Description of ${selectedTool.name}`
                  : 'Tool description'
              }
            >
              {selectedTool ? (
                <>
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
                  <p>
                    {selectedTool.description || 'No description provided.'}
                  </p>
                </>
              ) : (
                <p>Select a tool to read its full description.</p>
              )}
            </aside>
          </div>
          {tools.length === 0 && <p>No tools match this search.</p>}
        </>
      )}
    </section>
  )
}
