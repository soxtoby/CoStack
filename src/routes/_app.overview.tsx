import { createFileRoute } from '@tanstack/react-router'
import { Overview, useControlView } from '../components/control-app'

export const Route = createFileRoute('/_app/overview')({ component: Page })

function Page() {
  const view = useControlView()
  return <Overview {...view} />
}
