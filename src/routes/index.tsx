import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/')({
  beforeLoad: ({ location }) => {
    const query = new URLSearchParams(location.searchStr)
    if (query.has('connection')) {
      throw redirect({
        to: '/connections',
        search: {
          connection: query.get('connection')!,
          ...(query.get('oauth') === 'connected'
            ? { oauth: 'connected' as const }
            : {}),
        },
        replace: true,
      })
    }
    throw redirect({ to: '/overview', replace: true })
  },
})
