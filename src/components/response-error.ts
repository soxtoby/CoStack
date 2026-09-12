export async function responseError(response: Response): Promise<Error> {
  const text = await response.text()
  try {
    const data = JSON.parse(text) as { error?: unknown; message?: unknown }
    for (const value of [data.error, data.message])
      if (typeof value === 'string' && value) return new Error(value)
  } catch {
    if (response.headers.get('content-type')?.startsWith('text/plain') && text)
      return new Error(text)
  }
  return new Error(`Request failed (HTTP ${response.status})`)
}
