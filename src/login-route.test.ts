import { expect, test } from 'bun:test'
import { createRootRoute, createRouter } from '@tanstack/react-router'
import { Route as appRoute } from './routes/_app'
import { Route as loginRoute } from './routes/_app.login'

test('OAuth login resolves inside the authenticated app layout', () => {
  const root = createRootRoute()
  const app = appRoute.update({
    id: '/_app',
    getParentRoute: () => root,
  } as never)
  const login = loginRoute.update({
    path: '/login',
    getParentRoute: () => app,
  } as never)
  const router = createRouter({
    routeTree: root.addChildren([app.addChildren([login])]),
  })
  const matches = router.matchRoutes('/login')
  expect(matches.map((match) => match.routeId)).toEqual([
    '__root__',
    '/_app',
    '/_app/login',
  ])
})
