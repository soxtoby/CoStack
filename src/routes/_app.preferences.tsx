import { createFileRoute } from '@tanstack/react-router'
import { Preferences } from '../components/control-app'

export const Route = createFileRoute('/_app/preferences')({ component: Page })

function Page() {
  return <Preferences />
}
