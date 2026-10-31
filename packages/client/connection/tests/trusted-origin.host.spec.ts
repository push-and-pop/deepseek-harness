/** Explicit HTTPS proxy trust without forwarded-header authentication. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { apply, inject, type HostConnectionHandle, type HostConnectionService, type PeerScope, type ConnectionIndexResponse } from '../src/index.ts'
import { provideBrowserCredentials } from './browser-credentials.ts'

const ORIGIN = 'https://workstation.example.ts.net'
const HOST = 'workstation.example.ts.net'

function response(): { value: ConnectionIndexResponse; state: { status?: number; headers?: Readonly<Record<string, string>> } } {
  const state: { status?: number; headers?: Readonly<Record<string, string>> } = {}
  return { state, value: {
    writeHead(status, headers) { state.status = status; if (headers !== undefined) state.headers = headers },
    end() {},
  } }
}

async function withConnection(
  run: (ctx: Context, connection: HostConnectionService) => Promise<void>,
  trustedHosts: string[] = [],
): Promise<void> {
  const ctx = new Context()
  provideBrowserCredentials(ctx)
  const fiber = ctx.plugin({ inject: [...inject], apply }, { trustedHosts })
  try { await fiber.await(); await run(ctx, ctx.connection as HostConnectionService) }
  finally { await fiber.dispose() }
}

function browserPeer(connection: HostConnectionHandle, cookie: string, host = HOST): PeerScope {
  const admitted = connection.admit({ headers: { host, cookie } })
  if ('rejection' in admitted) throw new Error('test browser was not admitted')
  return admitted.peer
}

function exchange(connection: HostConnectionHandle, host = HOST): { cookie: string; setCookie: string } {
  const url = connection.authenticatedUrl(`https://${host}/`)
  const res = response()
  connection.authorizeIndex({ method: 'GET', url, headers: { host } }, res.value)
  expect(res.state.status).toBe(303)
  expect(res.state.headers?.location).toBe('./')
  const setCookie = res.state.headers?.['set-cookie']
  if (setCookie === undefined) throw new Error('test login did not set a cookie')
  return { cookie: setCookie.split(';', 1)[0]!, setCookie }
}

describe('registered HTTPS proxy origins', () => {
  it('requires an explicit exact authority grant before token exchange or API admission', async () => {
    await withConnection(async (_ctx, connection) => {
      const denied = response()
      connection.authorizeIndex({ method: 'GET', url: connection.authenticatedUrl(ORIGIN), headers: { host: HOST } }, denied.value)
      expect(denied.state.status).toBe(403)
      const release = connection.registerTrustedOrigin(`${ORIGIN}/`)
      try {
        expect(connection.allowsRemoteAuthorities).toBe(true)
        expect(connection.requestRejection({ headers: { host: HOST } })).toBe(401)
        for (const host of [`${HOST}:444`, `other.${HOST}`, '127.0.0.1:443']) {
          expect(connection.requestRejection({ headers: { host, origin: ORIGIN } })).toBe(403)
        }
        const login = exchange(connection)
        expect(login.setCookie).toContain('; HttpOnly; SameSite=Strict; Secure')
        expect(connection.requestRejection({ headers: { host: HOST, cookie: login.cookie } })).toBeUndefined()
        expect(connection.requestRejection({ headers: new Headers({ host: `${HOST}:443`, origin: ORIGIN, cookie: login.cookie }) })).toBeUndefined()
        expect(connection.requestRejection({ headers: { host: HOST, origin: ORIGIN, cookie: `${login.cookie}x` } })).toBe(401)
      } finally { await release() }
    })
  })

  it('rejects cross-origin and HTTP-origin requests without trusting forwarded headers', async () => {
    await withConnection(async (_ctx, connection) => {
      const release = connection.registerTrustedOrigin(ORIGIN)
      try {
        const { cookie } = exchange(connection)
        for (const origin of [`http://${HOST}`, 'https://attacker.example', 'null']) {
          const headers = { host: HOST, origin, cookie, 'x-forwarded-proto': 'https', 'x-forwarded-host': HOST }
          expect(connection.requestRejection({ headers })).toBe(403)
          const res = response()
          connection.authorizeIndex({ method: 'GET', url: connection.authenticatedUrl(ORIGIN), headers }, res.value)
          expect(res.state.status).toBe(403)
        }
        expect(connection.requestRejection({ headers: { host: HOST, origin: ORIGIN, cookie, 'sec-fetch-site': 'cross-site' } })).toBe(403)
        expect(connection.requestRejection({ headers: { host: HOST, cookie, 'x-forwarded-proto': 'http' } })).toBeUndefined()
        expect(connection.requestRejection({ headers: { host: 'unregistered.example', cookie, 'x-forwarded-host': HOST, 'x-forwarded-proto': 'https' } })).toBe(403)
      } finally { await release() }
    })
  })

  it('owns overlapping grants in each caller fiber and refuses subsequent access after the last release', async () => {
    await withConnection(async (ctx, connection) => {
      const first = ctx.plugin({ inject: ['connection'], apply(owner: Context) { owner.connection.registerTrustedOrigin(ORIGIN) } })
      const second = ctx.plugin({ inject: ['connection'], apply(owner: Context) { owner.connection.registerTrustedOrigin(ORIGIN) } })
      try {
        await first.await(); await second.await()
        const { cookie } = exchange(connection)
        const peer = browserPeer(connection, cookie)
        await first.dispose()
        expect(peer.signal.aborted).toBe(false)
        expect(browserPeer(connection, cookie)).toBe(peer)
        await second.dispose()
        expect(peer.signal.aborted).toBe(true)
        expect(connection.allowsRemoteAuthorities).toBe(false)
        expect(connection.requestRejection({ headers: { host: HOST, cookie } })).toBe(403)
        const denied = response()
        connection.authorizeIndex({ method: 'GET', url: connection.authenticatedUrl(ORIGIN), headers: { host: HOST, cookie } }, denied.value)
        expect(denied.state.status).toBe(403)
      } finally { await first.dispose(); await second.dispose() }
    })
  })

  it('keeps HTTPS and legacy HTTP cookie audiences separate on a statically trusted authority', async () => {
    await withConnection(async (_ctx, connection) => {
      const old = exchange(connection)
      expect(old.setCookie).not.toContain('; Secure')
      const release = connection.registerTrustedOrigin(ORIGIN)
      try {
        expect(connection.requestRejection({ headers: { host: HOST, cookie: old.cookie } })).toBe(401)
        const secure = exchange(connection)
        expect(secure.setCookie).toContain('; Secure')
        await release()
        expect(connection.requestRejection({ headers: { host: HOST, cookie: secure.cookie } })).toBe(401)
        expect(connection.requestRejection({ headers: { host: HOST, cookie: old.cookie } })).toBeUndefined()
      } finally { await release() }
      expect(connection.allowsRemoteAuthorities).toBe(true)
    }, [HOST])
  })

  it('uses registered HTTPS policy for independent API credentials and blocks reconnect after revocation', async () => {
    await withConnection(async (_ctx, connection) => {
      const release = connection.registerTrustedOrigin(ORIGIN)
      try {
        const res = response()
        connection.authorizeConnect({ method: 'GET', url: connection.authenticatedUrl(`${ORIGIN}/connect`), headers: { host: HOST } }, res.value)
        expect(res.state.status).toBe(302)
        const setCookie = res.state.headers?.['set-cookie']
        expect(setCookie).toContain('; Secure')
        const cookie = setCookie!.split(';', 1)[0]!
        const admitted = connection.admitConnection({ headers: { host: HOST, origin: ORIGIN, cookie } })
        if ('rejection' in admitted) throw new Error('registered API credential was rejected')
        await release()
        expect(admitted.peer.signal.aborted).toBe(true)
        expect(connection.admitConnection({ headers: { host: HOST, origin: ORIGIN, cookie } })).toEqual({ rejection: 403 })
        await admitted.release()
      } finally { await release() }
    })
  })

  it('revokes existing origin scopes and awaits their cleanup without disposing local or other-origin browsers', async () => {
    await withConnection(async (_ctx, connection) => {
      const release = connection.registerTrustedOrigin(ORIGIN)
      const otherHost = 'another.example.ts.net'
      const releaseOther = connection.registerTrustedOrigin(`https://${otherHost}`)
      const finish = Promise.withResolvers<undefined>()
      let released: Promise<void> | undefined
      try {
        const local = browserPeer(connection, exchange(connection, 'localhost').cookie, 'localhost')
        const login = exchange(connection)
        const peer = browserPeer(connection, login.cookie)
        const other = browserPeer(connection, exchange(connection, otherHost).cookie, otherHost)
        expect(local).toBe(connection.browserPeer)
        expect(peer).not.toBe(local)
        expect(peer).not.toBe(other)
        const socket = connection.admitConnection({ headers: { host: HOST, cookie: login.cookie } })
        if ('rejection' in socket) throw new Error('test socket was not admitted')
        expect(socket.peer).toBe(peer)
        const entered = Promise.withResolvers<undefined>()
        let closed = false
        peer.ctx.effect(() => async () => { entered.resolve(undefined); await finish.promise; closed = true }, 'test: active transport')
        released = release()
        await entered.promise
        expect(connection.requestRejection({ headers: { host: HOST, cookie: login.cookie } })).toBe(403)
        expect(peer.signal.aborted).toBe(true)
        expect(closed).toBe(false)
        expect(local.signal.aborted).toBe(false)
        expect(other.signal.aborted).toBe(false)
        finish.resolve(undefined)
        await released
        expect(closed).toBe(true)
        await socket.release()
      } finally {
        finish.resolve(undefined)
        await released
        await release()
        await releaseOther()
      }
    })
  })

  it('rejects noncanonical and non-HTTPS registration without granting access', async () => {
    await withConnection(async (_ctx, connection) => {
      for (const origin of ['not a URL', `http://${HOST}`, `${ORIGIN}/path`, `${ORIGIN}?q=1`, `${ORIGIN}#x`, `https://owner@${HOST}`, 'https://*.ts.net', `HTTPS://${HOST}`, `${ORIGIN}:443`, ` ${ORIGIN}`]) {
        expect(() => connection.registerTrustedOrigin(origin), origin).toThrow()
      }
      expect(connection.allowsRemoteAuthorities).toBe(false)
    })
  })
})
