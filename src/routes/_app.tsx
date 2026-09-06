import { createFileRoute } from '@tanstack/react-router'
import { App } from '../components/control-app'

export const Route = createFileRoute('/_app')({ component: App })
