/** Real Loader, HTTP carrier and Connection authentication; only the external Tailscale CLI is mocked. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import * as Tailscale from '../src/index.ts'
import * as Native from '../src/native.ts'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) {
    // The path is the exact private directory this fixture acquired with mkdtemp.
    await rm(root, { recursive: true, force: true })
    root = undefined
  }
  vi.restoreAllMocks()
})

async function boot(
  records = new Map<string, CredentialRecord>(), customDriver?: Native.TailscaleDriver,
): Promise<{ base: string; cookie: string; serve: ReturnType<typeof vi.fn>; release: () => Promise<void> }> {
  const serve = vi.fn<Native.TailscaleDriver['serve']>()
  vi.spyOn(Native, 'createNativeDriver').mockReturnValue(customDriver ?? { resolve: async () => undefined, run: vi.fn(), serve })
  root = await mkdtemp(join(tmpdir(), 'dsh-tailscale-loader-'))
  const file = join(root, 'cordis.yml')
  await writeFile(file, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    "  config: {host: '127.0.0.1', port: 0}",
    "- name: '@deepseek-ai/dsh-client-connection'",
    "- name: '@deepseek-ai/dsh-client-tailscale'",
    '',
  ].join('\n'))
  const ctx = context = new Context()
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  ctx.provide('credentials', {
    async modifyRecord(key: string, mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
  } as CredentialProvider)
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, object>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-client-connection', Connection],
    ['@deepseek-ai/dsh-client-tailscale', Tailscale],
  ])
  ctx.loader.internal = {
    version: 'v2',
    loadCache: new Map() as NonNullable<typeof ctx.loader.internal>['loadCache'],
    register() { throw new Error('fixture does not register ESM hooks') },
    getOrCreateModuleJob() { throw new Error('fixture does not create ESM jobs') },
    resolveSync() { throw new Error('fixture does not resolve ESM modules') },
    load() { throw new Error('fixture does not load ESM sources') },
    async import(specifier: string) {
      const module = modules.get(specifier)
      if (module === undefined) throw new Error(`unexpected test import: ${specifier}`)
      return module
    },
  }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(file).href } })
  await ctx.loader.await()
  expect([...ctx.loader.entries()].filter(row => row.fiber === undefined && !row.disabled)).toEqual([])
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/', handler: (req, res) => {
    if (ctx.connection.authorizeIndex(req, res)) res.end('authenticated fixture')
  } }))
  const base = ctx.webServer.getOrigin()
  const login = await fetch(ctx.connection.authenticatedUrl(base), { redirect: 'manual' })
  expect(login.status).toBe(303)
  const cookie = login.headers.get('set-cookie')?.split(';')[0]
  if (cookie === undefined) throw new Error('fixture missing cookie')
  const release = ctx.connection.registerTrustedOrigin('https://phone.example.ts.net:8443')
  return { base, cookie, serve, release }
}

it('protects local management with real browser authentication and rejects cross-site or remote authorities', async () => {
  const f = await boot()
  expect((await fetch(`${f.base}/tailscale/status`)).status).toBe(401)
  const status = await fetch(`${f.base}/tailscale/status`, { headers: { cookie: f.cookie } })
  expect(status.status).toBe(200)
  expect(status.headers.get('cache-control')).toBe('no-store')
  expect(await status.json()).toEqual({ state: 'not-installed' })
  expect((await fetch(`${f.base}/tailscale/status`, { headers: { cookie: f.cookie, origin: 'https://attacker.example' } })).status).toBe(403)
  expect((await fetch(`${f.base}/tailscale/status`, { headers: { cookie: f.cookie, 'x-forwarded-host': 'phone.example.ts.net' } })).status).toBe(403)
  const remoteStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(`${f.base}/tailscale/status`, { headers: { cookie: f.cookie, host: 'phone.example.ts.net:8443' } }, (response) => {
      response.resume()
      response.on('end', () => { resolve(response.statusCode) })
    })
    request.on('error', reject)
    request.end()
  })
  expect(remoteStatus).toBe(403)
  expect(f.serve).not.toHaveBeenCalled()
  await f.release()
})

it('validates command methods and empty JSON before starting CLI, and unload removes the routes', async () => {
  const f = await boot()
  const headers = { cookie: f.cookie, 'content-type': 'application/json' }
  expect((await fetch(`${f.base}/tailscale/start`, { headers })).status).toBe(405)
  for (const body of ['{', 'null', '[]', '{"command":"funnel"}', `{"x":"${'a'.repeat(1100)}"}`]) {
    expect((await fetch(`${f.base}/tailscale/start`, { method: 'POST', headers, body })).status).toBe(400)
  }
  const start = await fetch(`${f.base}/tailscale/start`, { method: 'POST', headers, body: '{}' })
  expect(await start.json()).toEqual({ state: 'not-installed' })
  expect(f.serve).not.toHaveBeenCalled()
  const row = [...context!.loader.entries()].find(entry => entry.options.name === '@deepseek-ai/dsh-client-tailscale')
  expect(row?.fiber).toBeDefined()
  await row!.fiber!.dispose()
  expect((await fetch(`${f.base}/tailscale/status`, { headers })).status).toBe(404)
  await f.release()
})

function readyDriver(): Native.TailscaleDriver {
  let target: string | undefined
  return {
    resolve: async () => '/test/tailscale',
    run: async (_exe, args) => JSON.stringify(args[0] === 'status'
      ? { BackendState: 'Running', Self: { Online: true, DNSName: 'pc.example.ts.net.' } }
      : target === undefined ? {} : { Foreground: { test: {
        TCP: { '8443': { HTTPS: true } },
        Web: { 'pc.example.ts.net:8443': { Handlers: { '/': { Proxy: target } } } },
      } } }),
    serve: (_exe, args) => {
      target = args[2]
      const finished = Promise.withResolvers<undefined>()
      return { done: finished.promise, stop: async () => { target = undefined; finished.resolve(undefined); await finished.promise } }
    },
  }
}

function privateRequest(base: string, link: string, headers: Record<string, string> = {}, method = 'GET') {
  const url = new URL(link)
  return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders }>((resolve, reject) => {
    const req = httpRequest(`${base}${url.pathname}${url.search}`, { method, headers: { host: url.host, ...headers } }, (res) => {
      res.resume()
      res.on('end', () => { resolve({ status: res.statusCode, headers: res.headers }) })
    })
    req.on('error', reject)
    req.end()
  })
}

it('keeps the same login link after restart on another local port, with authentication and shutdown checks', async () => {
  const records = new Map<string, CredentialRecord>()
  const first = await boot(records, readyDriver())
  const start = async (app: { base: string; cookie: string }): Promise<string> => {
    const res = await fetch(`${app.base}/tailscale/start`, {
      method: 'POST', headers: { cookie: app.cookie, 'content-type': 'application/json' }, body: '{}',
    })
    const value: unknown = await res.json()
    expect(value).toMatchObject({ state: 'running' })
    if (typeof value !== 'object' || value === null || !('url' in value) || typeof value.url !== 'string') {
      throw new Error('missing fixture login URL')
    }
    return value.url
  }
  const link = await start(first)
  expect(new URL(link).pathname).toBe('/tailscale/connect')
  const login = await privateRequest(first.base, link)
  expect(login.status).toBe(303)
  expect(login.headers.location).toBe('/')
  expect(login.headers['set-cookie']?.[0]).toContain('HttpOnly; SameSite=Strict; Secure')
  expect(login.headers['referrer-policy']).toBe('no-referrer')
  const processUrl = context!.connection.authenticatedUrl('https://pc.example.ts.net:8443')
  await context!.fiber.dispose()
  context = undefined
  // root is the private directory acquired by this exact boot fixture.
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  const second = await boot(records, readyDriver())
  expect(second.base).not.toBe(first.base)
  expect(context!.connection.authenticatedUrl('https://pc.example.ts.net:8443')).not.toBe(processUrl)
  expect((await privateRequest(second.base, link)).status).toBe(403)
  expect(await start(second)).toBe(link)
  expect((await privateRequest(second.base, link)).status).toBe(303)
  expect((await privateRequest(second.base, link, { host: 'evil.example' })).status).toBe(403)
  expect((await privateRequest(second.base, link, { origin: 'https://evil.example' })).status).toBe(403)
  expect((await privateRequest(second.base, link, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
  expect((await privateRequest(second.base, `${link}x`)).status).toBe(401)
  expect((await privateRequest(second.base, `${link}&token=duplicate`)).status).toBe(401)
  expect((await privateRequest(second.base, link, {}, 'POST')).status).toBe(405)
  const stopped = await fetch(`${second.base}/tailscale/stop`, {
    method: 'POST', headers: { cookie: second.cookie, 'content-type': 'application/json' }, body: '{}',
  })
  expect(stopped.status).toBe(200)
  expect((await privateRequest(second.base, link)).status).toBe(403)
  await first.release()
  await second.release()
})
