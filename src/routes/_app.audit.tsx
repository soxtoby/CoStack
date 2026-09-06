import { createFileRoute } from '@tanstack/react-router'
import { Audit } from '../components/control-app'

export const Route = createFileRoute('/_app/audit')({ component: Page })

function Page() {
  return <Audit />
}
