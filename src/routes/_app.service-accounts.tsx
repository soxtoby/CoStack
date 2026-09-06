import { createFileRoute } from '@tanstack/react-router'
import { Services, useControlView } from '../components/control-app'

export const Route = createFileRoute('/_app/service-accounts')({
  component: Page,
})

function Page() {
  const view = useControlView()
  return <Services {...view} />
}
