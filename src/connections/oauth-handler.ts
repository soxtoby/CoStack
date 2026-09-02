type OAuthOperations = {
  startOAuth: (
    accountId: string,
    principalId: string,
  ) => Promise<{ authorizationUrl: string }>
  finishOAuth: (
    state: string,
    code: string,
  ) => Promise<{ accountId: string; connectionId: string }>
}

/** The caller supplies the authenticated Principal. The callback relies on OAuth state. */
export async function upstreamOAuthHandler(
  request: Request,
  oauth: OAuthOperations,
  principalId?: string,
) {
  const url = new URL(request.url)
  if (request.method === 'POST' && url.pathname.endsWith('/start')) {
    if (!principalId)
      return Response.json({ error: 'Unauthorized' }, { status: 401 })
    const body = (await request.json()) as { accountId?: string }
    if (!body.accountId)
      return Response.json({ error: 'accountId is required' }, { status: 400 })
    return Response.json(await oauth.startOAuth(body.accountId, principalId))
  }
  if (request.method === 'GET' && url.pathname.endsWith('/callback')) {
    const state = url.searchParams.get('state')
    const code = url.searchParams.get('code')
    if (!state || !code)
      return Response.json(
        { error: 'Missing OAuth callback parameters' },
        { status: 400 },
      )
    const completed = await oauth.finishOAuth(state, code)
    return Response.json({ connected: true, ...completed })
  }
  return new Response('Not found', { status: 404 })
}
