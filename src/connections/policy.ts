import type { ToolPolicy, ToolPolicyEffect } from './types'

export function evaluateToolPolicy(
  policies: Array<ToolPolicy>,
  toolName: string,
): ToolPolicyEffect {
  const matches = policies
    .filter(({ pattern }) => globMatches(pattern, toolName))
    .sort(
      (left, right) => specificity(right.pattern) - specificity(left.pattern),
    )
  if (!matches.length) return 'block'
  const best = specificity(matches[0]!.pattern)
  const tied = matches.filter(({ pattern }) => specificity(pattern) === best)
  if (tied.some(({ effect }) => effect === 'block')) return 'block'
  if (tied.some(({ effect }) => effect === 'require_approval'))
    return 'require_approval'
  return 'allow'
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
): Array<ToolPolicy> {
  const others = policies.filter(({ pattern }) => pattern !== toolName)
  return evaluateToolPolicy(others, toolName) === effect
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
