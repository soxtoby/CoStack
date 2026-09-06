import { createFileRoute } from '@tanstack/react-router'
import { Users, useControlView } from '../components/control-app'

export const Route = createFileRoute('/_app/users')({ component: Page })

function Page() {
  const view = useControlView()
  return <Users {...view} />
}
