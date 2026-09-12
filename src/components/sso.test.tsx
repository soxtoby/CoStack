import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { AccessDenied, Sso } from './control-app'

test('configured SSO shows saved values, secret retention, and the IdP redirect URI', () => {
  const html = renderToStaticMarkup(
    <Sso
      embedded
      reload={() => {}}
      data={{
        state: 'ready',
        providers: [
          {
            provider_id: 'organization',
            issuer: 'https://issuer.example.com',
            domain: 'organization.invalid',
            client_id: 'saved-client-id',
          },
        ],
        ssoRedirectUri:
          'https://gateway.example.com/api/auth/sso/callback/organization',
      }}
    />,
  )
  expect(html).toContain('Provider configured in CoStack.')
  expect(html).toContain('value="saved-client-id"')
  expect(html).toContain('value="********"')
  expect(html).not.toContain('Microsoft Entra')
  expect(html).toContain(
    'https://gateway.example.com/api/auth/sso/callback/organization',
  )
  expect(html).toContain('Register this exact URI')
  expect(html).toContain('Save changes</button>')
  expect(html).not.toContain('button-icon')
  expect(html.match(/<input[^>]*name="clientSecret"[^>]*>/)?.[0]).not.toContain(
    'required',
  )
})

test('initial SSO setup exposes the redirect URI before saving and requires a secret', () => {
  const html = renderToStaticMarkup(
    <Sso
      embedded
      reload={() => {}}
      data={{
        state: 'ready',
        ssoRedirectUri:
          'https://gateway.example.com/api/auth/sso/callback/organization',
      }}
    />,
  )
  expect(html).toContain('No SSO provider configured yet.')
  expect(html).toContain('Save provider</button>')
  expect(html).toContain(
    'https://gateway.example.com/api/auth/sso/callback/organization',
  )
  expect(html.match(/<input[^>]*name="clientSecret"[^>]*>/)?.[0]).toContain(
    'required',
  )
})

test('access-denied pages distinguish missing access from unverified email and offer sign-out', () => {
  const missing = renderToStaticMarkup(
    <AccessDenied reason="not-added" email="actual@example.test" />,
  )
  expect(missing).toContain('Email: <strong>actual@example.test</strong>')
  expect(missing).toContain('An administrator needs to add your SSO email')
  const unverified = renderToStaticMarkup(
    <AccessDenied reason="email-unverified" />,
  )
  expect(unverified).toContain('identity provider did not confirm')
  for (const html of [missing, unverified])
    expect(html).toContain('Sign out and return to sign in')
})
