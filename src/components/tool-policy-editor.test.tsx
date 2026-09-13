import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { setToolPolicy } from '../connections/policy'
import { ToolPolicyEditor } from './tool-policy-editor'
import type { ToolPolicy } from '../connections/types'

test('keeps the sticky description attached to the configuration scroller', async () => {
  const css = await Bun.file(new URL('../styles.css', import.meta.url)).text()
  expect(css).toMatch(/\.configuration-editor\s*{[^}]*overflow:\s*clip;[^}]*}/s)
  expect(css).toMatch(
    /\.tool-description\s*{[^}]*position:\s*sticky;[^}]*top:\s*calc\(var\(--configuration-actions-height\) \+ 12px\);[^}]*}/s,
  )
  expect(css).toMatch(
    /\.form-actions\s*{[^}]*position:\s*sticky;[^}]*top:\s*0;[^}]*}/s,
  )
})

/** The action rendered as selected in a tool row's dropdown. */
function selectedAction(html: string, tool: string) {
  const row = html.slice(html.indexOf(`Action for ${tool}`))
  const match = row
    .slice(0, row.indexOf('</select>'))
    .match(/<option value="([a-z_]+)" selected=""/)
  return match?.[1]
}

test('shows editable pattern rules and add control above the tool list without expanding anything', () => {
  const html = renderToStaticMarkup(
    <ToolPolicyEditor
      policies={[
        { pattern: '*', effect: 'block' },
        { pattern: 'read_*', effect: 'allow' },
      ]}
      tools={[{ name: 'read_issue' }]}
      change={() => {}}
    />,
  )
  expect(html).toContain('aria-label="Policy definitions"')
  expect(html).toContain('value="read_*"')
  expect(html).toContain('Add pattern rule')
  expect(html).not.toContain('<details')
  expect(html.indexOf('Add pattern rule')).toBeLessThan(
    html.indexOf('Discovered tools'),
  )
  expect(html.indexOf('value="read_*"')).toBeLessThan(
    html.indexOf('Discovered tools'),
  )
})

test('keeps long descriptions out of unselected tool rows', () => {
  const description =
    'A short caption. '.repeat(12) + 'Full description details.'
  const html = renderToStaticMarkup(
    <ToolPolicyEditor
      policies={[]}
      tools={[{ name: 'read_issue', description }]}
      change={() => {}}
    />,
  )
  expect(html).toContain('A short caption.')
  expect(html).not.toContain('Full description details.')
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('aria-label="Action for read_issue"')
  expect(html).toContain('aria-label="Tool description"')
  expect(html).toContain('Select a tool to read its full description.')
})

test('shows discovered descriptions and evaluates overlapping rules in the editor', () => {
  const html = renderToStaticMarkup(
    <ToolPolicyEditor
      policies={[
        { pattern: '*', effect: 'block' },
        { pattern: 'read_*', effect: 'allow' },
        { pattern: 'read_private', effect: 'require_approval' },
      ]}
      tools={[
        { name: 'read_issue', description: 'Read a Linear issue' },
        { name: 'read_private', description: 'Read private details' },
        { name: 'delete_issue' },
      ]}
      change={() => {}}
    />,
  )
  expect(html).toContain('Read a Linear issue')
  expect(html).not.toContain('Use rules')
  expect(selectedAction(html, 'read_issue')).toBe('allow')
  expect(selectedAction(html, 'read_private')).toBe('require_approval')
  expect(selectedAction(html, 'delete_issue')).toBe('block')
  expect(html).not.toContain('<textarea')
})

test('the action a tool row shows is the action the rules produce', () => {
  const policies: Array<ToolPolicy> = [
    { pattern: '*', effect: 'block' },
    { pattern: 'read_*', effect: 'allow' },
  ]
  const tools = [{ name: 'read_issue' }]
  const html = renderToStaticMarkup(
    <ToolPolicyEditor
      policies={setToolPolicy(policies, 'read_issue', 'require_approval')}
      tools={tools}
      change={() => {}}
    />,
  )
  expect(selectedAction(html, 'read_issue')).toBe('require_approval')
})

test('invalid patterns disable the tool actions rather than showing a guess', () => {
  const html = renderToStaticMarkup(
    <ToolPolicyEditor
      policies={[{ pattern: '[invalid]', effect: 'allow' }]}
      tools={[{ name: 'read_issue' }]}
      change={() => {}}
    />,
  )
  expect(html).toContain('disabled=""')
  expect(selectedAction(html, 'read_issue')).toBeUndefined()
})

test('explains how to discover tools before choosing policies', () => {
  const html = renderToStaticMarkup(
    <ToolPolicyEditor policies={[]} tools={[]} change={() => {}} />,
  )
  expect(html).toContain('No tools discovered yet')
  expect(html).toContain('configure an Account')
  expect(html).toContain('Refresh tools')
})

test('invalid draft patterns produce an error instead of breaking tool previews', () => {
  const html = renderToStaticMarkup(
    <ToolPolicyEditor
      policies={[{ pattern: '[invalid]', effect: 'allow' }]}
      tools={[{ name: 'read_issue' }]}
      change={() => {}}
    />,
  )
  expect(html).toContain('role="alert"')
  expect(html).toContain('Unsupported tool glob')
  expect(html).toContain('Fix invalid patterns')
})

test('annotation selectors, tool actions and winning-rule explanations agree', () => {
  const html = renderToStaticMarkup(
    <ToolPolicyEditor
      policies={[
        { pattern: '*', effect: 'block' },
        { annotation: 'read_only', effect: 'allow' },
        { annotation: 'destructive', effect: 'require_approval' },
        { pattern: 'delete_one', effect: 'allow' },
      ]}
      tools={[
        { name: 'read', annotations: { readOnlyHint: true } },
        { name: 'unknown' },
        { name: 'delete_one' },
      ]}
      change={() => {}}
    />,
  )
  expect(html).toContain('aria-label="Destructive rule"')
  expect(html).toContain('Read-only rule')
  expect(html).toContain('Destructive rule')
  expect(html).toContain('Tool override: delete_one')
  expect(selectedAction(html, 'read')).toBe('allow')
  expect(selectedAction(html, 'unknown')).toBe('require_approval')
  expect(selectedAction(html, 'delete_one')).toBe('allow')
  expect(html).toContain('1 require approval')
  expect(html).toContain('2 allow')
})
