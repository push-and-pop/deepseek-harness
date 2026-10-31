// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { allowAllAccess, bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type {} from '../src/client/index.ts'
import { RemoteAccessSection, RemoteAccessNotice } from '../src/client/RemoteAccessSection.tsx'
import type { RemoteAccessProps, RemoteAccessNoticeProps } from '../src/client/RemoteAccessSection.tsx'
import { TailscaleClient } from '../src/client/controller.ts'
import { en, zh } from '../src/client/locales.ts'

afterEach(cleanup)
const unused = (() => { throw new Error('unused framework seat') }) as never
const globals = {
  useSessions: unused, useSessionStatus: unused, useSessionRetainInfo: unused, useResource: unused,
  useWorkspaces: unused, usePanelInfo: unused, ...allowAllAccess,
}
const url = 'https://pc.example.ts.net:8443/?token=secret-token'
function response(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }) }
function fixture(dictionary: typeof en | typeof zh = en) {
  const fetch = vi.fn<(input: string, init: RequestInit) => Promise<Response>>().mockImplementation(async () => response({ state: 'ready' }))
  const copy = vi.fn<(text: string) => Promise<void>>().mockResolvedValue()
  const client = new TailscaleClient({ fetch, copy })
  const t: RemoteAccessProps['t'] = (key, values) => {
    let text = (dictionary as Record<string, string>)[key] ?? key
    for (const [name, value] of Object.entries(values ?? {})) text = text.replaceAll(`{${name}}`, String(value))
    return text
  }
  const props: RemoteAccessProps = { ...globals, close: vi.fn(), t, useTailscale: bindSnapshotSelector(client.view),
    refresh: () => client.refresh(), start: () => client.start(), stop: () => client.stop(), copy: () => client.copy() }
  const noticeProps: RemoteAccessNoticeProps = {
    ...globals, t, useTailscaleNotice: bindSnapshotSelector(client.notice),
    dismissNotice: (id) => { client.dismiss(id) },
  }
  return { client, fetch, copy, props, noticeProps }
}

describe('remote-access settings user behavior', () => {
  it('guides setup without starting a connection and reports the enabled state after a user click', async () => {
    const { client, fetch, copy, props, noticeProps } = fixture()
    await client.refresh()
    render(<><RemoteAccessSection {...props} /><RemoteAccessNotice {...noticeProps} /></>)
    expect(screen.getByRole('link', { name: en['setup.download'] }).getAttribute('href')).toBe('https://tailscale.com/download')
    expect(screen.getByRole('link', { name: en['setup.dns'] }).getAttribute('href')).toBe('https://login.tailscale.com/admin/dns')
    expect(screen.getByText(en.lifetime)).toBeTruthy()
    expect(screen.getByText(en.security)).toBeTruthy()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(copy).not.toHaveBeenCalled()
    expect({
      title: screen.getByRole('region').getAttribute('aria-label'),
      status: screen.getByText(en['status.ready']).textContent,
      actions: screen.getAllByRole('button').map(button => button.textContent),
    }).toMatchInlineSnapshot(`
      {
        "actions": [
          "Refresh",
          "Enable remote access",
        ],
        "status": "Ready to enable",
        "title": "Remote access",
      }
    `)
    fetch.mockResolvedValueOnce(response({ state: 'running', dnsName: 'pc.example.ts.net', url }))
    fireEvent.click(screen.getByRole('button', { name: en.start }))
    await waitFor(() => { expect(screen.getByRole('button', { name: en.stop })).toBeTruthy() })
    expect(screen.getByText(en['toast.started'])).toBeTruthy()
    expect(screen.getByRole('img', { name: en['qr.label'] }).getAttribute('viewBox')).toMatch(/^0 0 \d+ \d+$/)
    expect(screen.getByText(en['qr.warning'])).toBeTruthy()
    expect(document.body.innerHTML).not.toContain('secret-token')
    expect(document.querySelector(`a[href="${url}"]`)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.copy }))
    await waitFor(() => { expect(copy).toHaveBeenCalledWith(url) })
    await waitFor(() => { expect(screen.getByText(en['toast.copied'])).toBeTruthy() })
    fireEvent.click(screen.getByRole('button', { name: en.stop }))
    expect(screen.queryByRole('img', { name: en['qr.label'] })).toBeNull()
    await waitFor(() => { expect(screen.getByRole('button', { name: en.start })).toBeTruthy() })
    expect(screen.queryByRole('button', { name: en.copy })).toBeNull()
    client.dispose()
  })

  it('shows prerequisite states in both languages without allowing enable', async () => {
    for (const dictionary of [en, zh]) {
      const { client, fetch, props } = fixture(dictionary)
      for (const state of ['not-installed', 'needs-login', 'offline'] as const) {
        fetch.mockResolvedValueOnce(response({ state }))
        await client.refresh()
        const view = render(<RemoteAccessSection {...props} />)
        expect(screen.getByText(dictionary[`status.${state}`])).toBeTruthy()
        expect(screen.getByRole('button', { name: dictionary.start }).hasAttribute('disabled')).toBe(true)
        view.unmount()
      }
      client.dispose()
    }
  })

  it('shows only PC management guidance after a remote refusal', async () => {
    const { client, fetch, props } = fixture(zh)
    fetch.mockResolvedValueOnce(response({ state: 'error', code: 'forbidden' }, 403))
    await client.refresh()
    render(<RemoteAccessSection {...props} />)
    expect(screen.getByText(zh.localOnly)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('img', { name: zh['qr.label'] })).toBeNull()
    client.dispose()
  })

  it('disables management while pending and retains status with localized recovery after failure', async () => {
    const { client, fetch, props } = fixture()
    await client.refresh()
    let fail!: (error: Error) => void
    fetch.mockReturnValueOnce(new Promise((_resolve, reject) => { fail = reject }))
    render(<RemoteAccessSection {...props} />)
    fireEvent.click(screen.getByRole('button', { name: en.start }))
    expect(screen.getByRole('button', { name: en.start }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByRole('button', { name: en.refresh }).hasAttribute('disabled')).toBe(true)
    await act(async () => { fail(new Error('untrusted private detail')); await Promise.resolve() })
    expect(screen.getByText(en['status.ready'])).toBeTruthy()
    expect(screen.getByRole('alert').textContent).toBe(en['error.operation'])
    expect(document.body.textContent).not.toContain('untrusted private detail')
    expect(screen.getByRole('button', { name: en.start }).hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: en.refresh }))
    await waitFor(() => { expect(screen.getByRole('button', { name: en.start }).hasAttribute('disabled')).toBe(false) })
    client.dispose()
  })

  it('shows an actionable error code without rendering raw Host text', async () => {
    const { client, fetch, props } = fixture()
    fetch.mockResolvedValueOnce(response({ state: 'error', code: 'busy-port', error: url }, 409))
    await client.refresh()
    render(<RemoteAccessSection {...props} />)
    expect(screen.getByRole('alert').textContent).toBe(en['error.busy-port'])
    expect(document.body.textContent).not.toContain(url)
    client.dispose()
  })

  it('keeps disabling available after an unconfirmed request while blocking secret-link copy', async () => {
    const { client, fetch, props } = fixture()
    fetch.mockResolvedValueOnce(response({ state: 'running', url }))
    await client.refresh()
    fetch.mockRejectedValueOnce(new Error('connection lost'))
    await client.refresh()
    render(<RemoteAccessSection {...props} />)
    expect(screen.getByRole('button', { name: en.stop }).hasAttribute('disabled')).toBe(false)
    expect(screen.getByRole('button', { name: en.copy }).hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('img', { name: en['qr.label'] })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: en.stop }))
    expect(screen.queryByRole('img', { name: en['qr.label'] })).toBeNull()
    await waitFor(() => { expect(screen.getByRole('button', { name: en.start })).toBeTruthy() })
    expect(fetch).toHaveBeenLastCalledWith('tailscale/stop', expect.objectContaining({ method: 'POST' }))
    client.dispose()
  })

  it('keeps operation feedback mounted independently of the settings panel', async () => {
    const { client, fetch, props, noticeProps } = fixture()
    await client.refresh()
    const page = render(<RemoteAccessSection {...props} />)
    render(<RemoteAccessNotice {...noticeProps} />)
    fetch.mockResolvedValueOnce(response({ state: 'running', url }))
    await act(() => client.start())
    page.unmount()
    expect(screen.getByRole('alert').textContent).toBe(en['toast.started'])
    act(() => { client.dispose() })
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
