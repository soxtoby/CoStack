import { OFFICIAL_REGISTRY } from './registry'
import type { RegistryServer } from './registry'

export function rankRegistryServers(
  entries: Array<RegistryServer>,
  registryUrl: string,
) {
  // Custom registries do not necessarily verify their publisher namespaces.
  const verifiedNamespaces =
    registryUrl.replace(/\/+$/, '') === OFFICIAL_REGISTRY
  return entries
    .map((entry) => ({
      ...entry,
      publisherHosted: verifiedNamespaces && isPublisherHosted(entry.server),
    }))
    .sort((a, b) => Number(b.publisherHosted) - Number(a.publisherHosted))
}

function isPublisherHosted(server: RegistryServer['server']) {
  const namespace = server.name.split('/')[0]!.toLowerCase()
  if (namespace === 'io.github' || namespace.startsWith('io.github.'))
    return false
  const labels = namespace.split('.')
  if (
    labels.length < 2 ||
    labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
  )
    return false
  const domain = labels.reverse().join('.')
  return (
    server.remotes?.some((remote) => {
      if (remote.type !== 'streamable-http') return false
      try {
        const url = new URL(remote.url)
        const hostname = url.hostname.toLowerCase().replace(/\.$/, '')
        return (
          url.protocol === 'https:' &&
          (hostname === domain || hostname.endsWith(`.${domain}`))
        )
      } catch {
        return false
      }
    }) ?? false
  )
}
