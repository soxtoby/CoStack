import { expect, test } from 'bun:test'
import {
  evaluateToolPolicy,
  resolveToolPolicy,
  setToolPolicy,
  validateToolPolicy,
} from './policy'
import type { ToolPolicy } from './types'

test('annotation rules use MCP defaults and ignore destructive hints on read-only tools', () => {
  const policies: Array<ToolPolicy> = [
    { pattern: '*', effect: 'block' },
    { annotation: 'read_only', effect: 'allow' },
    { annotation: 'destructive', effect: 'require_approval' },
  ]
  expect(
    evaluateToolPolicy(policies, 'read', {
      readOnlyHint: true,
      destructiveHint: true,
    }),
  ).toBe('allow')
  expect(evaluateToolPolicy(policies, 'unknown')).toBe('require_approval')
  expect(
    evaluateToolPolicy(policies, 'append', { destructiveHint: false }),
  ).toBe('block')
  const open: Array<ToolPolicy> = [
    { pattern: '*', effect: 'allow' },
    { annotation: 'open_world', effect: 'require_approval' },
  ]
  expect(evaluateToolPolicy(open, 'unknown')).toBe('require_approval')
  expect(evaluateToolPolicy(open, 'closed', { openWorldHint: false })).toBe(
    'allow',
  )
})

test('exact overrides beat patterns, annotations and defaults in either rule order', () => {
  const policies: Array<ToolPolicy> = [
    { pattern: '*', effect: 'block' },
    { annotation: 'destructive', effect: 'require_approval' },
    { pattern: 'delete_*', effect: 'block' },
    { pattern: 'delete_one', effect: 'allow' },
    { pattern: 'delete_one*', effect: 'block' },
  ]
  for (const rules of [policies, [...policies].reverse()]) {
    expect(resolveToolPolicy(rules, 'delete_one')).toEqual({
      effect: 'allow',
      source: 'Tool override: delete_one',
    })
    expect(resolveToolPolicy(rules, 'delete_two')).toEqual({
      effect: 'block',
      source: 'Pattern: delete_*',
    })
    expect(resolveToolPolicy(rules, 'update')).toEqual({
      effect: 'require_approval',
      source: 'Destructive rule',
    })
    expect(resolveToolPolicy(rules, 'read', { readOnlyHint: true })).toEqual({
      effect: 'block',
      source: 'Default action',
    })
  }
})

test('matching annotation rules choose the strongest effect and report its source', () => {
  const policies: Array<ToolPolicy> = [
    { annotation: 'read_only', effect: 'allow' },
    { annotation: 'open_world', effect: 'require_approval' },
  ]
  expect(resolveToolPolicy(policies, 'read', { readOnlyHint: true })).toEqual({
    effect: 'require_approval',
    source: 'Open-world rule',
  })
  expect(
    evaluateToolPolicy(
      [...policies, { annotation: 'destructive', effect: 'block' }],
      'unknown',
    ),
  ).toBe('block')
  expect(
    setToolPolicy(policies, 'read', 'allow', {
      readOnlyHint: true,
      openWorldHint: false,
    }),
  ).toEqual(policies)
  expect(
    setToolPolicy(policies, 'read', 'allow', { readOnlyHint: true }),
  ).toEqual([...policies, { pattern: 'read', effect: 'allow' }])
})

test('rejects invalid annotation rules and mixed matchers', () => {
  for (const policy of [
    { annotation: 'unknown', effect: 'allow' },
    { annotation: 'read_only', pattern: '*', effect: 'allow' },
    { effect: 'allow' },
    { annotation: 'read_only', effect: 'unknown' },
  ])
    expect(() => validateToolPolicy(policy as ToolPolicy)).toThrow()
})
