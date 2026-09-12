import { createFileRoute } from '@tanstack/react-router'
import { Settings } from '../components/control-app'

export const Route = createFileRoute('/_app/preferences')({ component: Page })

function Page() {
  return <Settings />
}
