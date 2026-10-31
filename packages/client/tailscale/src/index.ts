/** Private iPhone access through an owned Tailscale Serve process, managed only by the local owner. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-credentials'
import { TailscaleLink, authorizeStableLink } from './link-access.ts'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { createNativeDriver } from './native.ts'
import { TailscaleController } from './controller.ts'
import type { TailscaleConfig, TailscaleStatus } from './types.ts'

/** Stable Loader plugin name. */
export const name = 'tailscale'
/** Authenticated local Web carrier; no network access is enabled on plugin activation. */
export const inject = ['webServer', 'connection', 'credentials']
/** Local CLI and listener deployment choices. */
export interface Config extends TailscaleConfig {}
const milliseconds = (): z<number> => z.number().step(1).min(1).max(600_000)
/** Validated private-access settings. */
export const Config: z<Config> = z.object({
  executable: z.string().default('tailscale'),
  httpsPort: z.number().step(1).min(1).max(65535).default(8443),
  commandTimeoutMs: milliseconds().default(15000),
  shutdownGraceMs: milliseconds().default(3000),
  readinessPollMs: milliseconds().default(250),
})

function send(res: ServerResponse, status: number, body: TailscaleStatus): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function isLocalHost(req: IncomingMessage): boolean {
  const host = req.headers.host
  if (host === undefined || req.headers.forwarded !== undefined || req.headers['x-forwarded-host'] !== undefined) return false
  try {
    const url = new URL(`http://${host}`)
    return ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)
      && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')
  } catch (_error) {
    // Invalid request authority never grants local administration.
    return false
  }
}

async function emptyJson(req: IncomingMessage): Promise<boolean> {
  if (req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return false
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.byteLength
    if (size > 1024) { req.resume(); return false }
    chunks.push(chunk)
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 0
  } catch (_error) {
    // Malformed JSON is a request refusal, never a CLI operation.
    return false
  }
}

/** Install local-owner management routes and dispose the ephemeral tunnel on unload.
 * @param ctx Owning plugin context.
 * @param config Validated CLI and deadline settings.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const link = await TailscaleLink.create(ctx.credentials, ctx.get('profileContext')?.name ?? 'unprofiled')
  const controller = new TailscaleController(config, createNativeDriver(config), {
    registerTrustedOrigin: origin => ctx.connection.registerTrustedOrigin(origin),
    authenticatedUrl: origin => link.url(origin),
  }, ctx.webServer.getOrigin())
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/tailscale/connect',
    handler: (req, res) => { authorizeStableLink(req, res, controller.activeOrigin(), link, ctx.connection) },
  }), 'tailscale: persistent login entry')
  ctx.effect(() => () => controller.dispose(), 'tailscale: foreground Serve lifetime')
  for (const action of ['status', 'start', 'stop'] as const) {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact', path: `/tailscale/${action}`,
      handler: async (req, res) => {
        if (!isLocalHost(req)) { send(res, 403, { state: 'error', code: 'forbidden' }); return }
        const admission = ctx.connection.admit(req)
        if ('rejection' in admission) {
          send(res, admission.rejection, { state: 'error', code: admission.rejection === 401 ? 'unauthorized' : 'forbidden' })
          return
        }
        // Other plugins may augment principal kinds; only the owner can grant network access.
        // oxlint-disable-next-line typescript/no-unnecessary-condition -- other plugins extend the principal kind map.
        if (admission.peer.principal.kind !== 'owner') { send(res, 403, { state: 'error', code: 'forbidden' }); return }
        const method = action === 'status' ? 'GET' : 'POST'
        if (req.method !== method) {
          res.setHeader('allow', method)
          send(res, 405, { state: 'error', code: 'request-invalid' })
          return
        }
        if (action !== 'status' && !await emptyJson(req)) { send(res, 400, { state: 'error', code: 'request-invalid' }); return }
        const result = await controller[action]()
        send(res, result.state === 'error' ? 409 : 200, result)
      },
    }), `tailscale: ${action} route`)
  }
}
