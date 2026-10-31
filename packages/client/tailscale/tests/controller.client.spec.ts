import { describe, expect, it, vi } from 'vitest'
import { TailscaleClient, errorKey, parseStatus } from '../src/client/controller.ts'
import type { TailscaleBrowser } from '../src/client/controller.ts'
import { en, zh } from '../src/client/locales.ts'

const url = 'https://pc.example.ts.net:8443/?token=private-test-token'
const running = { state: 'running', dnsName: 'pc.example.ts.net', url }
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }) }
function fixture() {
  const fetch = vi.fn<TailscaleBrowser['fetch']>().mockImplementation(async () => response({ state: 'ready' }))
  const copy = vi.fn<TailscaleBrowser['copy']>().mockResolvedValue()
  return { client: new TailscaleClient({ fetch, copy }), fetch, copy }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe('remote-access management actions', () => {
  it('reads status without enabling, then posts explicit empty JSON and copies only on request', async () => {
    const { client, fetch, copy } = fixture()
    await client.refresh()
    expect(fetch).toHaveBeenLastCalledWith('tailscale/status', expect.objectContaining({ method: 'GET', cache: 'no-store', credentials: 'same-origin' }))
    expect(client.notice.getSnapshot()).toBeUndefined()
    expect(copy).not.toHaveBeenCalled()
    fetch.mockResolvedValueOnce(response(running))
    await client.start()
    const [startPath, startRequest] = fetch.mock.calls.at(-1)!
    expect(startPath).toBe('tailscale/start')
    expect(startRequest).toMatchObject({ method: 'POST', body: '{}' })
    expect(startRequest.headers).toEqual({ accept: 'application/json', 'content-type': 'application/json' })
    expect(client.notice.getSnapshot()).toMatchObject({ key: 'toast.started', success: true })
    expect(client.view.getSnapshot().status).toEqual(running)
    expect(copy).not.toHaveBeenCalled()
    await client.copy()
    expect(copy).toHaveBeenCalledWith(url)
    const copied = client.notice.getSnapshot()!
    client.dismiss(copied.id - 1)
    expect(client.notice.getSnapshot()).toBe(copied)
    client.dismiss(copied.id)
    expect(client.notice.getSnapshot()).toBeUndefined()
    await client.stop()
    expect(fetch).toHaveBeenLastCalledWith('tailscale/stop', expect.objectContaining({ method: 'POST', body: '{}' }))
    expect(client.notice.getSnapshot()).toMatchObject({ key: 'toast.stopped', success: true })
    expect(client.view.getSnapshot().status?.url).toBeUndefined()
    client.dispose()
  })

  it('treats an already-offline stopped connection as an idempotent success', async () => {
    const { client, fetch } = fixture()
    fetch.mockResolvedValueOnce(response({ state: 'offline' }))
    await client.stop()
    expect(client.notice.getSnapshot()).toMatchObject({ key: 'toast.stopped', success: true })
    expect(client.view.getSnapshot().status).toEqual({ state: 'offline' })
    client.dispose()
  })

  it('serializes gestures and discards late completion after disposal', async () => {
    const { client, fetch } = fixture()
    const pending = deferred<Response>()
    fetch.mockReturnValueOnce(pending.promise)
    const request = client.refresh()
    await Promise.all([client.start(), client.stop(), client.refresh(), client.copy()])
    expect(fetch).toHaveBeenCalledTimes(1)
    const signal = fetch.mock.calls[0]![1].signal!
    client.dispose()
    expect(signal.aborted).toBe(true)
    pending.resolve(response(running))
    await request
    expect(client.view.getSnapshot().status).toBeUndefined()
    expect(client.notice.getSnapshot()).toBeUndefined()
    await client.refresh()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('clears secret links and presents PC-only management after a forbidden response', async () => {
    const { client, fetch, copy } = fixture()
    fetch.mockResolvedValueOnce(response(running))
    await client.refresh()
    fetch.mockResolvedValueOnce(new Response(null, { status: 403 }))
    await client.stop()
    expect(client.view.getSnapshot()).toMatchObject({ status: undefined, localOnly: true, pending: undefined })
    expect(client.notice.getSnapshot()?.key).toBe('localOnly')
    await Promise.all([client.copy(), client.start(), client.refresh()])
    expect(copy).not.toHaveBeenCalled()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('localizes an expired login without reading an untrusted error body', async () => {
    const { client, fetch } = fixture()
    fetch.mockResolvedValueOnce(new Response('not JSON with private details', { status: 401 }))
    await client.start()
    expect(client.view.getSnapshot().status).toEqual({ state: 'error', code: 'unauthorized' })
    expect(client.notice.getSnapshot()?.key).toBe('error.unauthorized')
  })

  it('keeps prior state but removes the link when a management result is unknown', async () => {
    const { client, fetch } = fixture()
    fetch.mockResolvedValueOnce(response(running))
    await client.refresh()
    fetch.mockRejectedValueOnce(new Error('sensitive detail that must not be displayed'))
    await client.stop()
    expect(client.view.getSnapshot()).toMatchObject({ status: { state: 'running' }, failure: 'operation' })
    expect(client.view.getSnapshot().status?.url).toBeUndefined()
    expect(client.notice.getSnapshot()?.key).toBe('error.operation')
    fetch.mockResolvedValueOnce(response({ state: 'ready' }))
    await client.refresh()
    expect(client.view.getSnapshot().failure).toBeUndefined()
  })

  it('contains malformed JSON and unexpected HTTP failures with a retryable status-read failure', async () => {
    const { client, fetch } = fixture()
    for (const result of [new Response('invalid json'), response({ state: 'unrecognized' }), response({ state: 'ready' }, 500)]) {
      fetch.mockResolvedValueOnce(result)
      await client.refresh()
      expect(client.view.getSnapshot().failure).toBe('query')
      expect(client.view.getSnapshot().status?.url).toBeUndefined()
    }
    expect(client.notice.getSnapshot()).toBeUndefined()
  })

  it('uses stable error codes rather than Host prose and never reports a failed operation as success', async () => {
    const { client, fetch } = fixture()
    fetch.mockResolvedValueOnce(response({ state: 'error', code: 'busy-port', error: url }, 409))
    await client.start()
    expect(client.view.getSnapshot().status).toEqual({ state: 'error', code: 'busy-port' })
    expect(client.notice.getSnapshot()).toMatchObject({ key: 'error.busy-port', success: false })
    fetch.mockResolvedValueOnce(response({ state: 'ready' }))
    await client.start()
    expect(client.notice.getSnapshot()).toMatchObject({ key: 'error.operation', success: false })
  })

  it('blocks duplicate clipboard writes and discards clipboard results after disposal', async () => {
    const { client, fetch, copy } = fixture()
    await client.copy()
    expect(copy).not.toHaveBeenCalled()
    fetch.mockResolvedValueOnce(response(running))
    await client.refresh()
    copy.mockRejectedValueOnce(new Error('clipboard denied'))
    await client.copy()
    expect(client.notice.getSnapshot()).toMatchObject({ key: 'error.copy', success: false })
    const pending = deferred<undefined>()
    copy.mockReturnValueOnce(pending.promise)
    const copying = client.copy()
    await client.copy()
    expect(copy).toHaveBeenCalledTimes(2)
    client.dispose()
    pending.resolve(undefined)
    await copying
    expect(client.notice.getSnapshot()).toBeUndefined()
  })

  it('does not publish a response whose JSON decoded after disposal', async () => {
    const { client, fetch } = fixture()
    const decoded = deferred<unknown>()
    const reply = response({})
    vi.spyOn(reply, 'json').mockReturnValue(decoded.promise)
    fetch.mockResolvedValueOnce(reply)
    const request = client.refresh()
    await Promise.resolve()
    client.dispose()
    decoded.resolve(running)
    await request
    expect(client.view.getSnapshot().status).toBeUndefined()
  })
})

describe('management response validation and dictionaries', () => {
  it('accepts only supported states and private HTTPS sign-in links', () => {
    for (const state of ['not-installed', 'needs-login', 'offline', 'ready', 'running', 'error']) expect(parseStatus({ state })?.state).toBe(state)
    for (const value of [null, [], 'running', {}, { state: 1 }, { state: 'ready', dnsName: 3 }, { state: 'error', code: [] }, { state: 'error', error: {} }]) expect(parseStatus(value)).toBeUndefined()
    for (const invalid of ['broken', 'http://pc.example.ts.net/', 'https://evil.test/', 'https://user:pass@pc.example.ts.net/']) expect(parseStatus({ state: 'running', url: invalid })).toBeUndefined()
    expect(parseStatus({ ...running, injected: 'ignored', error: url })).toEqual(running)
    expect(parseStatus({ state: 'ready', url })).toEqual({ state: 'ready' })
  })

  it('keeps English and Chinese copy aligned and all Host error codes actionable', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
    for (const code of ['not-installed', 'command-failed', 'invalid-status', 'invalid-dns', 'busy-port', 'funnel-enabled', 'not-ready', 'unsupported-listener', 'start-timeout', 'serve-exited', 'disposed', 'forbidden', 'unauthorized', 'request-invalid', 'upgrade-required', 'internal-error', undefined, 'future-code']) {
      const key = errorKey(code)
      expect(en[key].length).toBeGreaterThan(10)
      expect(zh[key].length).toBeGreaterThan(5)
    }
    expect(en.lifetime).toContain('Enable it again')
    expect(zh.security).toContain('令牌')
  })
})
