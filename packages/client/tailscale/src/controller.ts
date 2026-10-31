/** Owns one ephemeral private Serve listener and its exact HTTPS trust registration. */
import { setTimeout as delay } from 'node:timers/promises'
import { TailscaleError, parseObject, nodeStatus, assertUnusedPort, hasPrivateProxy, type TailscaleConfig, type TailscaleStatus } from './protocol.ts'
import type { ServeProcess, TailscaleDriver } from './native.ts'

/** Connection-owned authentication operations; neither identity nor tokens are reimplemented here. */
export interface TailscaleConnection {
  registerTrustedOrigin(origin: string): () => Promise<void>
  authenticatedUrl(baseUrl: string): string
}

interface ActiveServe {
  readonly process: ServeProcess
  readonly origin: string
  readonly dnsName: string
  readonly target: string
  readonly executable: string
  alive: boolean
  release?: () => Promise<void>
  settlement: Promise<void>
}

/** Serialized local user operations and lifecycle cleanup for one foreground listener. */
export class TailscaleController {
  private readonly lifetime = new AbortController()
  private pending: Promise<void> = Promise.resolve()
  private active: ActiveServe | undefined
  private failure: string | undefined
  private readonly starts = new Set<AbortController>()

  constructor(
    private readonly config: TailscaleConfig,
    private readonly driver: TailscaleDriver,
    private readonly connection: TailscaleConnection,
    private readonly target: string,
  ) {}

  /** Currently admitted origin.
   * @returns The active HTTPS origin, or undefined before readiness, after exit, or during shutdown.
   */
  activeOrigin(): string | undefined {
    const active = this.active
    return active?.alive === true && active.release !== undefined ? active.origin : undefined
  }

  /** Refresh node and Serve state without publishing secrets outside the local owner page.
   * @returns Verified node/listener state or a stable failure code.
   */
  status(): Promise<TailscaleStatus> {
    return this.enqueue(async () => {
      const executable = await this.driver.resolve()
      if (executable === undefined) {
        await this.stopActive()
        return { state: 'not-installed' }
      }
      const status = nodeStatus(await this.json(executable, ['status', '--json']))
      const active = this.active
      if (active !== undefined) {
        if (status.state !== 'ready' || status.dnsName !== active.dnsName) {
          await this.stopActive()
          return status
        }
        const serve = await this.json(executable, ['serve', 'status', '--json'])
        if (!active.alive || !hasPrivateProxy(serve, active.dnsName, this.config.httpsPort, active.target)) {
          await this.stopActive()
          throw new TailscaleError('serve-exited')
        }
        return { state: 'running', dnsName: active.dnsName, url: this.connection.authenticatedUrl(active.origin) }
      }
      if (this.failure !== undefined) {
        const code = this.failure
        this.failure = undefined
        return { state: 'error', code }
      }
      return status
    })
  }

  /** Enable only an unused private HTTPS foreground listener; never calls Funnel, reset, up, or login.
   * @returns Running state after Serve reports this exact proxy, otherwise a stable failure.
   */
  start(): Promise<TailscaleStatus> {
    const cancellation = new AbortController()
    this.starts.add(cancellation)
    const signal = AbortSignal.any([this.lifetime.signal, cancellation.signal, AbortSignal.timeout(this.config.commandTimeoutMs)])
    const checkCancelled = (): void => {
      if (signal.aborted) throw new TailscaleError(cancellation.signal.aborted ? 'start-cancelled' : 'start-timeout')
    }
    return this.enqueue(async () => {
      checkCancelled()
      if (this.active !== undefined) return this.runningState(this.active)
      this.failure = undefined
      const target = new URL(this.target)
      if (target.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(target.hostname) || target.username !== '' || target.password !== '') {
        throw new TailscaleError('unsupported-listener')
      }
      if (typeof this.connection.registerTrustedOrigin !== 'function') throw new TailscaleError('upgrade-required')
      const executable = await this.driver.resolve()
      checkCancelled()
      if (executable === undefined) return { state: 'not-installed' }
      const node = nodeStatus(await this.json(executable, ['status', '--json'], signal))
      checkCancelled()
      if (node.state !== 'ready' || node.dnsName === undefined) return node
      assertUnusedPort(await this.json(executable, ['serve', 'status', '--json'], signal), this.config.httpsPort)
      checkCancelled()
      const origin = new URL(`https://${node.dnsName}:${this.config.httpsPort}`).origin
      const process = this.driver.serve(executable, ['serve', `--https=${this.config.httpsPort}`, this.target])
      const active: ActiveServe = {
        process, origin, dnsName: node.dnsName, executable, target: this.target,
        alive: true, settlement: Promise.resolve(),
      }
      this.active = active
      active.settlement = process.done.then(async () => {
        active.alive = false
        await active.release?.()
        if (this.active === active) { this.failure = 'serve-exited'; this.active = undefined }
      }, async () => {
        active.alive = false
        await active.release?.()
        if (this.active === active) { this.failure = 'serve-exited'; this.active = undefined }
      })
      try {
        while (active.alive) {
          checkCancelled()
          const serve = await this.json(executable, ['serve', 'status', '--json'], signal)
          if (hasPrivateProxy(serve, active.dnsName, this.config.httpsPort, this.target)) {
            checkCancelled()
            // oxlint-disable-next-line typescript/no-unnecessary-condition -- CLI exit can change alive during the awaited probe.
            if (!active.alive) throw new TailscaleError('serve-exited')
            active.release = this.connection.registerTrustedOrigin(origin)
            return this.runningState(active)
          }
          await delay(this.config.readinessPollMs, undefined, { signal })
        }
        throw new TailscaleError('serve-exited')
      } catch (error) {
        await this.stopActive()
        if (error instanceof TailscaleError) throw error
        throw new TailscaleError(signal.aborted ? 'start-timeout' : 'command-failed', { cause: error })
      }
    }).finally(() => { this.starts.delete(cancellation) })
  }

  /** Revoke DSH trust before waiting for the owned foreground CLI to exit.
   * @returns Stopped state; does not change any other Serve configuration or Tailscale login.
   */
  stop(): Promise<TailscaleStatus> {
    for (const start of this.starts) start.abort()
    return this.enqueue(async () => {
      const dnsName = this.active?.dnsName
      await this.stopActive()
      this.failure = undefined
      return dnsName === undefined ? { state: 'offline' } : { state: 'ready', dnsName }
    })
  }

  /** Abort bounded commands, await pending work, revoke trust, and await CLI exit. */
  async dispose(): Promise<void> {
    this.lifetime.abort()
    for (const start of this.starts) start.abort()
    await this.pending
    await this.stopActive()
  }

  private runningState(active: ActiveServe): TailscaleStatus {
    if (!active.alive || active.release === undefined) throw new TailscaleError('serve-exited')
    return { state: 'running', dnsName: active.dnsName, url: this.connection.authenticatedUrl(active.origin) }
  }

  private async stopActive(): Promise<void> {
    const active = this.active
    if (active === undefined) return
    this.active = undefined
    await active.release?.()
    await active.process.stop()
    await active.settlement
  }

  private async json(executable: string, args: readonly string[], parent = this.lifetime.signal): Promise<Record<string, unknown>> {
    const signal = AbortSignal.any([parent, this.lifetime.signal, AbortSignal.timeout(this.config.commandTimeoutMs)])
    return parseObject(await this.driver.run(executable, args, signal))
  }

  private enqueue(operation: () => Promise<TailscaleStatus>): Promise<TailscaleStatus> {
    const result = this.pending.then(async () => {
      if (this.lifetime.signal.aborted) return { state: 'error' as const, code: 'disposed' }
      try { return await operation() }
      catch (error) {
        // Stop the affected listener even when an externally changed Serve configuration becomes unsafe.
        await this.stopActive()
        const code = error instanceof TailscaleError ? error.code : 'command-failed'
        // This failure is returned directly; a later refresh must be able to recover readiness.
        this.failure = undefined
        return { state: 'error' as const, code }
      }
    })
    this.pending = result.then(() => {})
    return result
  }
}
