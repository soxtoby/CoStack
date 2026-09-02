import { tanstackConfig } from '@tanstack/eslint-config'

export default [
  { ignores: ['dist/**', 'src/routeTree.gen.ts', '*.config.js'] },
  ...tanstackConfig,
]
