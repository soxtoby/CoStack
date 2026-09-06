import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ToolPolicyEditor } from './tool-policy-editor'

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
  expect(html).toContain('Effective action: Allow')
  expect(html).toContain('Effective action: Require approval')
  expect(html).toContain('Effective action: Block')
  expect(html).not.toContain('<textarea')
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
