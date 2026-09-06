import { createFileRoute } from '@tanstack/react-router'
import { Access, useControlView } from '../components/control-app'

export const Route = createFileRoute('/_app/pre-provisioned-access')({
  component: Page,
})

function Page() {
  const view = useControlView()
  return <Access {...view} />
}
