import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'

export const Route = createFileRoute('/_app/login')({ component: ResumeLogin })

function ResumeLogin() {
  useEffect(() => {
    location.replace(
      location.search ? `/oauth/consent${location.search}` : '/connections',
    )
  }, [])
  return <div className="loading">Continuing MCP authorization</div>
}
