import { describe, expect, it, vi } from 'vitest'
import { TailscaleController } from '../src/controller.ts'
import { nativeEnvironment, createNativeDriver, type TailscaleDriver } from '../src/native.ts'
import { assertUnusedPort, hasPrivateProxy, nodeStatus, parseObject, TailscaleError, type TailscaleConfig } from '../src/protocol.ts'

const config: TailscaleConfig = { executable: 'tailscale', httpsPort: 8443, commandTimeoutMs: 1000, shutdownGraceMs: 50, readinessPollMs: 1 }
const target = 'http://127.0.0.1:54750'
const dnsName = 'my-pc.example.ts.net'
const ready = { BackendState: 'Running', Self: { Online: true, DNSName: `${dnsName}.` } }
function proxy(funnel = false): Record<string, unknown> {
  return { Foreground: { owned: {
    TCP: { '8443': { HTTPS: true } },
    Web: { [`${dnsName}:8443`]: { Handlers: { '/': { Proxy: target } } } },
    ...(funnel ? { AllowFunnel: { [`${dnsName}:8443`]: true } } : {}),
  } } }
}

function fixture() {
  let served = false
  let finish: () => void = () => {}
  const done = new Promise<void>((resolve) => { finish = resolve })
  const release = vi.fn(async () => {})
  const register = vi.fn(() => release)
  const driver: TailscaleDriver = {
    resolve: vi.fn(async () => '/tailscale'),
    run: vi.fn<TailscaleDriver['run']>(async (_executable, args) => JSON.stringify(args[0] === 'status' ? ready : served ? proxy() : {})),
    serve: vi.fn(() => {
      served = true
      return { done, stop: vi.fn(async () => { finish(); await done }) }
    }),
  }
  const connection = { registerTrustedOrigin: register, authenticatedUrl: (origin: string) => `${origin}/?token=test-only` }
  const controller = new TailscaleController(config, driver, connection, target)
  return { controller, driver, register, release, finish }
}

describe('private foreground access', () => {
  it('stays offline on activation, verifies exact proxy before granting trust, and revokes on stop', async () => {
    const f = fixture()
    expect(await f.controller.status()).toEqual({ state: 'ready', dnsName })
    expect(f.driver.serve).not.toHaveBeenCalled()
    expect(await f.controller.start()).toEqual({ state: 'running', dnsName, url: `https://${dnsName}:8443/?token=test-only` })
    expect(f.driver.serve).toHaveBeenCalledWith('/tailscale', ['serve', '--https=8443', target])
    expect(f.register).toHaveBeenCalledWith(`https://${dnsName}:8443`)
    expect(await f.controller.status()).toMatchObject({ state: 'running' })
    expect(await f.controller.stop()).toEqual({ state: 'ready', dnsName })
    expect(f.release).toHaveBeenCalled()
    await f.controller.dispose()
    expect(await f.controller.start()).toEqual({ state: 'error', code: 'disposed' })
  })

  it('reports missing installation and login without running Serve', async () => {
    const f = fixture()
    vi.mocked(f.driver.resolve).mockResolvedValue(undefined)
    expect(await f.controller.start()).toEqual({ state: 'not-installed' })
    vi.mocked(f.driver.resolve).mockResolvedValue('/tailscale')
    vi.mocked(f.driver.run).mockResolvedValue(JSON.stringify({ BackendState: 'NeedsLogin' }))
    expect(await f.controller.start()).toEqual({ state: 'needs-login' })
    expect(f.driver.serve).not.toHaveBeenCalled()
    await f.controller.dispose()
  })

  it('refuses non-loopback listeners and keeps another application’s port unchanged', async () => {
    const f = fixture()
    vi.mocked(f.driver.run).mockImplementation(async (_exe, args) => JSON.stringify(args[0] === 'status' ? ready : { TCP: { '8443': { HTTPS: true } } }))
    expect(await f.controller.start()).toEqual({ state: 'error', code: 'busy-port' })
    expect(f.driver.serve).not.toHaveBeenCalled()
    const other = new TailscaleController(config, f.driver, { registerTrustedOrigin: f.register, authenticatedUrl: value => value }, 'http://192.168.1.2:3080')
    expect(await other.start()).toEqual({ state: 'error', code: 'unsupported-listener' })
    await other.dispose()
    await f.controller.dispose()
  })

  it('revokes trust on unexpected CLI exit and permits explicit restart', async () => {
    const f = fixture()
    await f.controller.start()
    f.finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(f.release).toHaveBeenCalled()
    expect(await f.controller.status()).toEqual({ state: 'error', code: 'serve-exited' })
    await f.controller.dispose()
  })

  it('revokes and stops when an external change enables Funnel', async () => {
    const f = fixture()
    await f.controller.start()
    vi.mocked(f.driver.run).mockImplementation(async (_exe, args) => JSON.stringify(args[0] === 'status' ? ready : proxy(true)))
    expect(await f.controller.status()).toEqual({ state: 'error', code: 'funnel-enabled' })
    expect(f.release).toHaveBeenCalled()
    await f.controller.dispose()
  })

  it('serializes duplicate start actions and awaits foreground shutdown on disposal', async () => {
    const f = fixture()
    await Promise.all([f.controller.start(), f.controller.start()])
    expect(f.driver.serve).toHaveBeenCalledTimes(1)
    await f.controller.dispose()
    expect(f.release).toHaveBeenCalled()
  })

  it('cancels every queued start during preflight before any listener or trust can be created', async () => {
    const f = fixture()
    let resume: () => void = () => {}
    let notify: () => void = () => {}
    const waiting = new Promise<void>((resolve) => { resume = resolve })
    const entered = new Promise<void>((resolve) => { notify = resolve })
    vi.mocked(f.driver.run).mockImplementation(async () => {
      notify()
      await waiting
      return JSON.stringify(ready)
    })
    const first = f.controller.start()
    const second = f.controller.start()
    await entered
    const stop = f.controller.stop()
    resume()
    expect(await first).toEqual({ state: 'error', code: 'start-cancelled' })
    expect(await second).toEqual({ state: 'error', code: 'start-cancelled' })
    expect(await stop).toEqual({ state: 'offline' })
    expect(f.driver.serve).not.toHaveBeenCalled()
    expect(f.register).not.toHaveBeenCalled()
    await f.controller.dispose()
  })

  it('recovers readiness after a failed start so a later user action can retry', async () => {
    const f = fixture()
    vi.mocked(f.driver.run).mockImplementation(async (_exe, args) => JSON.stringify(args[0] === 'status' ? ready : { TCP: { '8443': { HTTPS: true } } }))
    expect(await f.controller.start()).toEqual({ state: 'error', code: 'busy-port' })
    expect(await f.controller.status()).toEqual({ state: 'ready', dnsName })
    await f.controller.dispose()
  })

  it('does not trust a proxy for another process and stops on deadline', async () => {
    const f = fixture()
    vi.mocked(f.driver.run).mockImplementation(async (_exe, args) => JSON.stringify(args[0] === 'status' ? ready : {}))
    const controller = new TailscaleController(
      { ...config, commandTimeoutMs: 10 }, f.driver,
      { registerTrustedOrigin: f.register, authenticatedUrl: value => value }, target,
    )
    expect(await controller.start()).toEqual({ state: 'error', code: 'start-timeout' })
    expect(f.register).not.toHaveBeenCalled()
    await controller.dispose()
    await f.controller.dispose()
  })
})

describe('CLI output validation', () => {
  it('rejects malformed JSON, DNS names, and unsafe Serve declarations', () => {
    for (const text of ['null', '[]', '{', '42']) expect(() => parseObject(text)).toThrow(TailscaleError)
    expect(() => nodeStatus({})).toThrow(TailscaleError)
    for (const name of ['evil.example', 'x.ts.net:443', 'https://x.ts.net', 'x..ts.net', '*.ts.net']) {
      expect(() => nodeStatus({ ...ready, Self: { Online: true, DNSName: name } })).toThrow(TailscaleError)
    }
    expect(nodeStatus({ BackendState: 'Stopped' })).toEqual({ state: 'offline' })
    expect(nodeStatus({ BackendState: 'Running', Self: { Online: false } })).toEqual({ state: 'offline' })
    expect(() =>{  assertUnusedPort(proxy(true), 8443) }).toThrow('funnel-enabled')
    expect(() =>{  assertUnusedPort({ Foreground: [] }, 8443) }).toThrow('invalid-status')
    expect(hasPrivateProxy(proxy(), dnsName, 8443, 'http://127.0.0.1:9999')).toBe(false)
    expect(hasPrivateProxy(proxy(), dnsName, 8443, target)).toBe(true)
    expect(hasPrivateProxy({ Web: proxy().Web }, dnsName, 8443, target)).toBe(false)
  })
})

describe('native CLI isolation', () => {
  it('passes only system paths and locales, never credentials or DSH state', () => {
    expect(nativeEnvironment({ PATH: '/bin', SystemRoot: 'C:\\Windows', DEEPSEEK_API_KEY: 'secret', DSH_TOKEN: 'secret', TAILSCALE_AUTHKEY: 'secret', CUSTOM: 'secret' }))
      .toEqual({ PATH: '/bin', SystemRoot: 'C:\\Windows' })
  })

  it('resolves and runs a real native executable without shell interpretation', async () => {
    const driver = createNativeDriver({ ...config, executable: process.execPath })
    const executable = await driver.resolve()
    expect(executable).toBe(process.execPath)
    expect(await driver.run(process.execPath, ['-e', 'process.stdout.write("ok")'], AbortSignal.timeout(5000))).toBe('ok')
    await expect(driver.run(process.execPath, ['-e', 'process.exit(7)'], AbortSignal.timeout(5000))).rejects.toThrow('command-failed')
    await expect(driver.run(process.execPath, ['-e', 'setInterval(()=>{},1000)'], AbortSignal.timeout(50))).rejects.toThrow('command-timeout')
    const child = driver.serve(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
    await child.stop()
    await child.done
  })
})
