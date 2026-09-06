import { createFileRoute } from '@tanstack/react-router'
import { Groups, useControlView } from '../components/control-app'

export const Route = createFileRoute('/_app/groups')({ component: Page })

function Page() {
  const view = useControlView()
  return <Groups {...view} />
}
