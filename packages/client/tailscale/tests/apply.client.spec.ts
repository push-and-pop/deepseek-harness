/** Registration and locale lifetimes run against the real client registries. */
import { Context } from '@deepseek-ai/cordis'
import { createElement, Fragment } from 'react'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, inject } from '../src/client/index.ts'
import type { RemoteAccessInjected, RemoteAccessNoticeInjected } from '../src/client/RemoteAccessSection.tsx'

function TestRoot({ renderSlot }: PropsRenderSlots<'settings.section' | 'shell.overlay'>) {
  return createElement(Fragment, null,
    renderSlot('settings.section', { close: () => {} }),
    renderSlot('shell.overlay', {}))
}

it('registers locale-following settings without enabling and removes sources and slots on unload', async () => {
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ state: 'ready' })))
  vi.stubGlobal('fetch', fetcher)
  const ctx = new Context()
  try {
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    installConnection(ctx)
    const slots = ctx.slots
    const owner = () => slots.register({ name: 'root', children: {
      'settings.section': { kind: 'list', scope: 'root' },
      'shell.overlay': { kind: 'list', scope: 'root' },
    } }, TestRoot)
    let removeOwner = owner()
    const fiber = ctx.plugin({ inject, apply })
    await fiber.await()
    await vi.waitFor(() => { expect(fetcher).toHaveBeenCalledTimes(1) })
    expect(fetcher.mock.calls[0]?.[0]).toBe('tailscale/status')
    expect(slots.entries('settings.section')).toHaveLength(1)
    const section = slots.entries('settings.section')[0]!
    expect(section.options).toMatchObject({ id: 'tailscale' })
    expect(section.locale).toBe('tailscale')
    const face = section.inject!() as RemoteAccessInjected & Record<string, unknown>
    await vi.waitFor(() => { expect(face.hooks.tailscale.getSnapshot().status?.state).toBe('ready') })
    const toast = slots.entries('shell.overlay')[0]!.inject!() as RemoteAccessNoticeInjected & Record<string, unknown>
    expect(toast.hooks.tailscaleNotice.getSnapshot()).toBeUndefined()
    ctx.locale.setLocale('en')
    expect(resolveSlotLabel(section.options.label)).toBe('Remote access')
    ctx.locale.setLocale('zh')
    expect(resolveSlotLabel(section.options.label)).toBe('手机远程访问')
    removeOwner()
    expect(slots.entries('settings.section')).toHaveLength(0)
    removeOwner = owner()
    expect(slots.entries('settings.section')).toHaveLength(1)
    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.entries('shell.overlay')).toHaveLength(0)
    expect(face.hooks.tailscale.getSnapshot().status).toBeUndefined()
    expect(toast.hooks.tailscaleNotice.getSnapshot()).toBeUndefined()
    await face.start()
    expect(fetcher.mock.calls.every(([path]) => path === 'tailscale/status')).toBe(true)
    removeOwner()
  } finally {
    await ctx.fiber.dispose()
    vi.unstubAllGlobals()
  }
})
