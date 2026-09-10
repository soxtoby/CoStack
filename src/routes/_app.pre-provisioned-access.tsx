import { createFileRoute, redirect } from '@tanstack/react-router'

export const Route = createFileRoute('/_app/pre-provisioned-access')({
  beforeLoad: () => {
    throw redirect({ to: '/users' })
  },
})
