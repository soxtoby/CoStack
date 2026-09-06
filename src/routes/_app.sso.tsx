import { createFileRoute } from '@tanstack/react-router'
import { Sso, useControlView } from '../components/control-app'

export const Route = createFileRoute('/_app/sso')({ component: Page })

function Page() {
  const view = useControlView()
  return <Sso {...view} />
}
