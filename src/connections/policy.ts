import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js'
import type {
  ToolPolicy,
  ToolPolicyAnnotation,
  ToolPolicyEffect,
} from './types'

export const annotationLabels: Record<ToolPolicyAnnotation, string> = {
  read_only: 'Read-only',
  destructive: 'Destructive',
  open_world: 'Open-world',
}

export function defaultToolPolicies(): Array<ToolPolicy> {
  return [
    { pattern: '*', effect: 'block' },
    { annotation: 'read_only', effect: 'allow' },
    { annotation: 'destructive', effect: 'require_approval' },
  ]
}

export function evaluateToolPolicy(
  policies: Array<ToolPolicy>,
  toolName: string,
  annotations?: ToolAnnotations,
): ToolPolicyEffect {
  return resolveToolPolicy(policies, toolName, annotations).effect
}

export function resolveToolPolicy(
  policies: Array<ToolPolicy>,
  toolName: string,
  annotations?: ToolAnnotations,
): { effect: ToolPolicyEffect; source: string } {
  const matches = policies
    .flatMap<{ policy: ToolPolicy; rank: number; specificity: number }>(
      (policy) => {
        validateToolPolicy(policy)
        if (policy.annotation !== undefined)
          return annotationMatches(policy.annotation, annotations)
            ? [{ policy, rank: 1, specificity: 0 }]
            : []
        if (!globMatches(policy.pattern, toolName)) return []
        const rank =
          policy.pattern === '*' ? 0 : !/[?*]/.test(policy.pattern) ? 3 : 2
        return [
          {
            policy,
            rank,
            specificity: rank === 2 ? specificity(policy.pattern) : 0,
          },
        ]
      },
    )
    .sort(
      (a, b) =>
        b.rank - a.rank ||
        b.specificity - a.specificity ||
        strength(b.policy.effect) - strength(a.policy.effect),
    )
  const match = matches[0]
  if (!match) return { effect: 'block', source: 'No matching rule' }
  const rule = match.policy
  return {
    effect: rule.effect,
    source:
      rule.annotation !== undefined
        ? annotationLabels[rule.annotation] + ' rule'
        : rule.pattern === '*'
          ? 'Default action'
          : match.rank === 3
            ? 'Tool override: ' + rule.pattern
            : 'Pattern: ' + rule.pattern,
  }
}

function strength(effect: ToolPolicyEffect) {
  return effect === 'block' ? 2 : effect === 'require_approval' ? 1 : 0
}
function annotationMatches(
  annotation: ToolPolicyAnnotation,
  hints?: ToolAnnotations,
) {
  if (annotation === 'read_only') return hints?.readOnlyHint === true
  if (annotation === 'destructive')
    return hints?.readOnlyHint !== true && hints?.destructiveHint !== false
  return hints?.openWorldHint !== false
}

export function validateToolPolicy(
  policy: unknown,
): asserts policy is ToolPolicy {
  if (!policy || typeof policy !== 'object')
    throw new Error('Invalid policy action')
  const rule = policy as Record<string, unknown>
  if (
    typeof rule.effect !== 'string' ||
    !['allow', 'block', 'require_approval'].includes(rule.effect)
  )
    throw new Error('Invalid policy action')
  if (rule.annotation !== undefined) {
    if (
      rule.pattern !== undefined ||
      typeof rule.annotation !== 'string' ||
      !Object.hasOwn(annotationLabels, rule.annotation)
    )
      throw new Error('Invalid annotation rule')
  } else {
    if (typeof rule.pattern !== 'string')
      throw new Error('A tool pattern or annotation is required')
    validateGlob(rule.pattern)
  }
}

export function policyFromRow(row: {
  pattern?: unknown
  annotation?: unknown
  effect: unknown
}): ToolPolicy {
  return row.annotation != null
    ? {
        annotation: row.annotation as ToolPolicyAnnotation,
        effect: row.effect as ToolPolicyEffect,
      }
    : { pattern: row.pattern as string, effect: row.effect as ToolPolicyEffect }
}

/**
 * The rules that give `toolName` this effect. An exact name beats every pattern
 * that matches it, so a rule for the tool always wins; it is dropped instead
 * when the remaining rules already produce the effect, so choosing the action a
 * tool already has does not leave a redundant rule behind.
 */
export function setToolPolicy(
  policies: Array<ToolPolicy>,
  toolName: string,
  effect: ToolPolicyEffect,
  annotations?: ToolAnnotations,
): Array<ToolPolicy> {
  const others = policies.filter(({ pattern }) => pattern !== toolName)
  return evaluateToolPolicy(others, toolName, annotations) === effect
    ? others
    : [...others, { pattern: toolName, effect }]
}

export function validateGlob(pattern: string) {
  if (
    !pattern ||
    ['[', ']', '{', '}', '\\'].some((character) => pattern.includes(character))
  )
    throw new Error(`Unsupported tool glob: ${pattern}`)
}

function specificity(pattern: string) {
  return pattern.replaceAll('*', '').replaceAll('?', '').length
}

function globMatches(pattern: string, value: string) {
  validateGlob(pattern)
  const escaped = pattern.replace(/[.+^$()|]/g, '\\$&')
  return new RegExp(
    `^${escaped.replaceAll('*', '.*').replaceAll('?', '.')}$`,
  ).test(value)
}
