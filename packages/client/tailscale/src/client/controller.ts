/** Owns authenticated management reads and transient results; sign-in URLs stay in memory. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TailscaleStatus } from '../types.ts'
import type { TailscaleKey } from './locales.ts'

/** Management actions are serialized, including clipboard writes. */
type Action = 'refresh' | 'start' | 'stop' | 'copy'

/** Page state shared with the notification host, without browser persistence. */
export interface TailscaleView {
  readonly status: TailscaleStatus | undefined
  readonly pending: Action | undefined
  readonly failure: 'query' | 'operation' | undefined
  readonly localOnly: boolean
}

/** Localized transient feedback remains visible after the settings panel closes. */
export interface TailscaleNotice {
  readonly id: number
  readonly key: TailscaleKey
  readonly success: boolean
}

/** Injectable browser operations; tests never open a real connection or clipboard. */
export interface TailscaleBrowser {
  fetch(input: string, init: RequestInit): Promise<Response>
  copy(text: string): Promise<void>
}

/** Parse the management response without retaining unexpected fields or unsafe links.
 * @param value Decoded response JSON.
 * @returns The validated status, or undefined for a malformed response.
 */
export function parseStatus(value: unknown): TailscaleStatus | undefined {
  if (!isRecord(value)) return undefined
  if (!('state' in value)) return undefined
  const { state } = value
  if (state !== 'not-installed' && state !== 'needs-login' && state !== 'offline'
    && state !== 'ready' && state !== 'running' && state !== 'error') return undefined
  for (const key of ['dnsName', 'url', 'error', 'code'] as const) {
    if (key in value && typeof value[key] !== 'string') return undefined
  }
  let url: string | undefined
  if ('url' in value && typeof value.url === 'string' && state === 'running') {
    let parsed: URL
    try { parsed = new URL(value.url) }
    catch (_error) { return undefined }
    if (parsed.protocol !== 'https:' || !parsed.hostname.endsWith('.ts.net') || parsed.username || parsed.password) return undefined
    url = value.url
  }
  return {
    state,
    ...'dnsName' in value && typeof value.dnsName === 'string' ? { dnsName: value.dnsName } : {},
    ...'code' in value && typeof value.code === 'string' ? { code: value.code } : {},
    ...url === undefined ? {} : { url },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Management lifetime, separate from presentation and from the Host's tunnel lifetime. */
export class TailscaleClient {
  /** No persistence: this source can contain a secret sign-in URL. */
  readonly view = createSnapshotStore<TailscaleView>({ status: undefined, pending: undefined, failure: undefined, localOnly: false })
  /** The shell overlay owns rendering this short-lived feedback. */
  readonly notice = createSnapshotStore<TailscaleNotice | undefined>(undefined)
  private operation: AbortController | undefined
  private disposed = false
  private noticeId = 0

  /** @param browser HTTP and clipboard operations owned by this plugin instance. */
  constructor(private readonly browser: TailscaleBrowser) {}

  /** Refresh status without changing network exposure. @returns After the response has been published. */
  refresh(): Promise<void> { return this.request('refresh') }
  /** Enable only after an explicit user action. @returns After the Host result has been published. */
  start(): Promise<void> { return this.request('start') }
  /** Stop only this plugin's connection. @returns After the Host result has been published. */
  stop(): Promise<void> { return this.request('stop') }

  /** Copy the current sign-in URL only in response to a user gesture.
   * @returns After the clipboard write settles; failure is localized by the notification host.
   */
  async copy(): Promise<void> {
    const current = this.view.getSnapshot()
    if (this.disposed || current.pending || current.localOnly || current.failure || current.status?.url === undefined) return
    const operation = new AbortController()
    this.operation = operation
    this.view.set({ ...current, pending: 'copy' })
    try {
      await this.browser.copy(current.status.url)
      if (!operation.signal.aborted) this.report('toast.copied', true)
    } catch (_error) {
      if (!operation.signal.aborted) this.report('error.copy', false)
    } finally {
      if (!operation.signal.aborted) {
        this.operation = undefined
        this.view.set({ ...this.view.getSnapshot(), pending: undefined })
      }
    }
  }

  /** Dismiss only the notice that finished, never its newer replacement.
   * @param id Notice instance id.
   */
  dismiss(id: number): void {
    if (this.notice.getSnapshot()?.id === id) this.notice.set(undefined)
  }

  /** Abort reads and discard secrets; this does not stop the Host-owned tunnel. */
  dispose(): void {
    this.disposed = true
    this.operation?.abort()
    this.operation = undefined
    this.view.set({ status: undefined, pending: undefined, failure: undefined, localOnly: false })
    this.notice.set(undefined)
  }

  private report(key: TailscaleKey, success: boolean): void {
    this.notice.set({ id: ++this.noticeId, key, success })
  }

  private async request(action: Exclude<Action, 'copy'>): Promise<void> {
    const current = this.view.getSnapshot()
    if (this.disposed || current.pending || current.localOnly) return
    const operation = new AbortController()
    this.operation = operation
    this.view.set({ ...current, pending: action })
    try {
      const response = await this.browser.fetch(`tailscale/${action === 'refresh' ? 'status' : action}`, {
        method: action === 'refresh' ? 'GET' : 'POST',
        headers: { accept: 'application/json', ...action === 'refresh' ? {} : { 'content-type': 'application/json' } },
        ...action === 'refresh' ? {} : { body: '{}' },
        credentials: 'same-origin', cache: 'no-store', signal: operation.signal,
      })
      if (operation.signal.aborted) return
      if (response.status === 403) {
        this.view.set({ status: undefined, pending: undefined, failure: undefined, localOnly: true })
        if (action !== 'refresh') this.report('localOnly', false)
        return
      }
      if (response.status === 401) {
        this.view.set({ status: { state: 'error', code: 'unauthorized' }, pending: undefined, failure: undefined, localOnly: false })
        if (action !== 'refresh') this.report('error.unauthorized', false)
        return
      }
      const decoded: unknown = await response.json()
      // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can abort while JSON decoding is pending.
      if (operation.signal.aborted) return
      const status = parseStatus(decoded)
      if (status === undefined || (!response.ok && status.state !== 'error')) throw new Error('Invalid management response')
      this.view.set({ status, pending: undefined, failure: undefined, localOnly: false })
      if (action !== 'refresh') {
        const success = response.ok && (action === 'start' ? status.state === 'running' : status.state !== 'error' && status.state !== 'running')
        this.report(success ? (action === 'start' ? 'toast.started' : 'toast.stopped') : errorKey(status.code), success)
      }
    } catch (_error) {
      if (operation.signal.aborted) return
      const { url: _secret, ...status } = current.status ?? { state: 'error' as const }
      this.view.set({ status, pending: undefined, failure: action === 'refresh' ? 'query' : 'operation', localOnly: false })
      if (action !== 'refresh') this.report('error.operation', false)
    } finally {
      if (this.operation === operation) this.operation = undefined
    }
  }
}

/** Resolve only known error identifiers; server text and arbitrary codes never become UI copy.
 * @param code Stable Host error identifier.
 * @returns A locale key with an actionable generic fallback.
 */
export function errorKey(code: string | undefined): TailscaleKey {
  switch (code) {
    case 'not-installed': return 'error.not-installed'
    case 'command-failed': return 'error.command-failed'
    case 'invalid-status': return 'error.invalid-status'
    case 'invalid-dns': return 'error.invalid-dns'
    case 'busy-port': return 'error.busy-port'
    case 'funnel-enabled': return 'error.funnel-enabled'
    case 'not-ready': return 'error.not-ready'
    case 'unsupported-listener': return 'error.unsupported-listener'
    case 'start-timeout': return 'error.start-timeout'
    case 'serve-exited': return 'error.serve-exited'
    case 'disposed': return 'error.disposed'
    case 'forbidden': return 'localOnly'
    case 'unauthorized': return 'error.unauthorized'
    case 'request-invalid': return 'error.request-invalid'
    case 'upgrade-required': return 'error.upgrade-required'
    case 'internal-error': return 'error.internal-error'
    default: return 'error.operation'
  }
}
