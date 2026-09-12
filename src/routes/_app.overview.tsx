import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/overview')({
  beforeLoad: () => {
    throw redirect({ to: '/connections', replace: true })
  },
})
