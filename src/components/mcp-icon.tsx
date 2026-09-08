import { useState } from 'react'

export function McpIcon({
  src,
  name,
}: {
  src?: string | undefined
  name: string
}) {
  const [failed, setFailed] = useState<string>()
  const allowed =
    src?.startsWith('https://') ||
    (src?.startsWith('/') && !src.startsWith('//'))
  return (
    <span className="mcp-icon" aria-hidden="true">
      {allowed && failed !== src ? (
        <img
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setFailed(src)}
        />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  )
}
