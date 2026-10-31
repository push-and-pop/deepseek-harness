/** Validate bounded Tailscale CLI output before granting any remote authority. */
import type { TailscaleStatus } from './types.ts'
export type { TailscaleStatus, TailscaleConfig } from './types.ts'

/** Stable failures mapped to localized copy by the settings page. */
export class TailscaleError extends Error {
  constructor(readonly code: string, options?: ErrorOptions) {
    super(`tailscale: ${code}`, options)
  }
}

/** Parse command output at the process boundary without accepting arrays or primitives.
 * @param text Complete bounded JSON output.
 * @returns A JSON object, or a structured failure.
 */
export function parseObject(text: string): Record<string, unknown> {
  let value: unknown
  try { value = JSON.parse(text) }
  catch (error) { throw new TailscaleError('invalid-status', { cause: error }) }
  if (!isObject(value)) throw new TailscaleError('invalid-status')
  return value
}

/** Whether a decoded JSON value is an object.
 * @param value Process output field.
 * @returns True for non-null, non-array objects.
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Extract the validated MagicDNS name from a running node.
 * @param status Parsed `tailscale status --json` result.
 * @returns Ready, login-required, or offline state.
 */
export function nodeStatus(status: Record<string, unknown>): TailscaleStatus {
  if (typeof status.BackendState !== 'string') throw new TailscaleError('invalid-status')
  if (status.BackendState === 'NeedsLogin' || status.BackendState === 'NeedsMachineAuth') return { state: 'needs-login' }
  if (status.BackendState !== 'Running') return { state: 'offline' }
  if (!isObject(status.Self) || status.Self.Online !== true || typeof status.Self.DNSName !== 'string') {
    return { state: 'offline' }
  }
  const dnsName = status.Self.DNSName.replace(/\.$/u, '')
  if (!dnsName.endsWith('.ts.net') || dnsName.length > 253
    || dnsName.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label))) {
    throw new TailscaleError('invalid-dns')
  }
  return { state: 'ready', dnsName }
}

/** Background and foreground configurations whose chosen port must remain private.
 * @param config Parsed `tailscale serve status --json` result.
 * @returns Root and foreground configurations, rejecting malformed collections.
 */
function serveConfigs(config: Record<string, unknown>): Record<string, unknown>[] {
  if (config.Foreground === undefined) return [config]
  if (!isObject(config.Foreground)) throw new TailscaleError('invalid-status')
  const foreground = Object.values(config.Foreground)
  if (foreground.some(value => !isObject(value))) throw new TailscaleError('invalid-status')
  return [config, ...foreground.filter(isObject)]
}

/** Refuse existing listeners rather than overwriting another application's Serve or Funnel.
 * @param config Parsed Serve configuration.
 * @param port Requested HTTPS listener port.
 */
export function assertUnusedPort(config: Record<string, unknown>, port: number): void {
  for (const row of serveConfigs(config)) {
    assertNoFunnel(row, port)
    if (row.TCP !== undefined && (!isObject(row.TCP) || Object.hasOwn(row.TCP, String(port)))) {
      throw new TailscaleError('busy-port')
    }
    if (row.Web !== undefined && (!isObject(row.Web)
      || Object.keys(row.Web).some(key => key.endsWith(`:${port}`)))) throw new TailscaleError('busy-port')
  }
}

function assertNoFunnel(row: Record<string, unknown>, port: number): void {
  if (row.AllowFunnel === undefined) return
  if (!isObject(row.AllowFunnel)) throw new TailscaleError('invalid-status')
  if (Object.entries(row.AllowFunnel).some(([host, enabled]) => enabled !== false && host.endsWith(`:${port}`))) {
    throw new TailscaleError('funnel-enabled')
  }
}

/** Verify a private HTTPS foreground listener points at this exact DSH process.
 * @param config Parsed Serve configuration.
 * @param dnsName Validated node name.
 * @param port Requested listener port.
 * @param target Loopback DSH origin.
 * @returns True only after the foreground configuration is observable.
 */
export function hasPrivateProxy(config: Record<string, unknown>, dnsName: string, port: number, target: string): boolean {
  const rows = serveConfigs(config)
  for (const row of rows) assertNoFunnel(row, port)
  return rows.slice(1).some((row) => {
    if (!isObject(row.TCP)) return false
    const listener = row.TCP[String(port)]
    if (!isObject(listener) || listener.HTTPS !== true) return false
    if (!isObject(row.Web)) return false
    const web = row.Web[`${dnsName}:${port}`]
    if (!isObject(web) || !isObject(web.Handlers)) return false
    const handler = web.Handlers['/']
    return isObject(handler) && (handler.Proxy === target || handler.Proxy === `${target}/`)
  })
}
