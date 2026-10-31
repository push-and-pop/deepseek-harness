/** Profile-owned persistent login links; the normal DSH launch token stays process-local. */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { isObject, TailscaleError } from './protocol.ts'

function storedSecret(record: CredentialRecord | undefined): string {
  if (record?.kind !== 'grant' || !isObject(record.payload) || record.payload.version !== 1
    || typeof record.payload.secret !== 'string' || !/^[a-f0-9]{64}$/u.test(record.payload.secret)) {
    throw new TailscaleError('link-storage-error')
  }
  return record.payload.secret
}

/** A stable high-entropy bearer link, limited to this profile and exact HTTPS origin. */
export class TailscaleLink {
  private constructor(private readonly secret: string) {}

  /** Initialize or reuse one credential record without storing any login link in config.
   * @param credentials Host credential provider; owns durable storage and locking.
   * @param profile Stable profile name; the provider already separates Harness homes.
   * @returns A link issuer with no network access of its own.
   */
  static async create(credentials: CredentialProvider, profile: string): Promise<TailscaleLink> {
    const key = credentialKey('tailscale-link', `profile-${createHash('sha256').update(profile).digest('hex')}`)
    const record = await credentials.modifyRecord(key, (current) => {
      if (current !== undefined) { storedSecret(current); return Promise.resolve(undefined) }
      return Promise.resolve<CredentialRecord>({ kind: 'grant', payload: { version: 1, secret: randomBytes(32).toString('hex') } })
    })
    return new TailscaleLink(storedSecret(record))
  }

  /** Build the persistent browser entry; only an active private origin serves it.
   * @param origin Canonical HTTPS origin selected by Tailscale Serve.
   * @returns Stable login URL, including its secret query token.
   */
  url(origin: string): string {
    const url = new URL('/tailscale/connect', origin)
    url.searchParams.set('token', this.token(origin))
    return url.href
  }

  /** Verify a presented link token for the exact currently active origin.
   * @param origin Active HTTPS origin.
   * @param token Untrusted token from one query parameter.
   * @returns True only for the profile/origin-specific token.
   */
  accepts(origin: string, token: string): boolean {
    const expected = Buffer.from(this.token(origin))
    const actual = Buffer.from(token)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  private token(origin: string): string {
    return createHmac('sha256', Buffer.from(this.secret, 'hex'))
      .update(`dsh-tailscale-browser-link-v1\0${origin}`).digest('base64url')
  }
}

/** Exchange the private stable link through Connection without exposing its fresh process token.
 * @param req Original HTTP request; the browser-facing Host must be preserved by Serve.
 * @param res Response owned to completion.
 * @param origin Active private origin, or undefined while access is off.
 * @param link Profile-specific persistent link verifier.
 * @param connection Existing DSH browser authentication owner.
 */
export function authorizeStableLink(
  req: IncomingMessage, res: ServerResponse, origin: string | undefined, link: TailscaleLink, connection: HostConnectionHandle,
): void {
  const reject = (status: number): void => {
    res.writeHead(status, { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
    res.end()
  }
  if (req.method !== 'GET') { res.setHeader('allow', 'GET'); reject(405); return }
  if (origin === undefined) { reject(403); return }
  const expectedUrl = new URL(origin)
  const host = expectedUrl.host
  const incomingHost = req.headers.host?.toLowerCase()
  if ((incomingHost !== host && (expectedUrl.port !== '' || incomingHost !== `${host}:443`))
    || (req.headers.origin !== undefined && req.headers.origin !== origin)
    || req.headers['sec-fetch-site'] === 'cross-site') { reject(403); return }
  let url: URL
  try { url = new URL(req.url ?? '', origin) }
  catch (_error) { reject(400); return }
  const tokens = url.searchParams.getAll('token')
  if (url.origin !== origin || url.pathname !== '/tailscale/connect'
    || tokens.length !== 1 || !link.accepts(origin, tokens[0] ?? '')) { reject(401); return }
  const accepted = connection.authorizeIndex({
    method: 'GET', headers: req.headers, url: connection.authenticatedUrl(origin),
  }, {
    writeHead(status, headers) {
      res.writeHead(status, { ...headers, ...headers?.location === undefined ? {} : { location: '/' } })
    },
    end(body) { res.end(body) },
  })
  if (accepted) { res.writeHead(303, { location: '/', 'cache-control': 'no-store' }); res.end() }
}
