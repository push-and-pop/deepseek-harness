/** Settings registration for private, user-enabled Tailscale access. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { TailscaleClient } from './controller.ts'
import { RemoteAccessSection, RemoteAccessNotice } from './RemoteAccessSection.tsx'
import type { RemoteAccessInjected, RemoteAccessNoticeInjected } from './RemoteAccessSection.tsx'
import { en, zh, type TailscaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Private remote-access settings copy. */
    tailscale: TailscaleKey
  }
}

/** Locale, slot lifecycle, and connection-reset notifications used by this browser half. */
export const inject = ['slots', 'locale', 'connection']

/** Mount settings and feedback without enabling remote access automatically.
 * @param ctx Browser plugin context; all transport and clipboard access stays in this closure.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('tailscale', { en, zh }), 'tailscale: dictionaries')
  const controller = new TailscaleClient({
    fetch: (input, init) => globalThis.fetch(input, init),
    copy: text => navigator.clipboard.writeText(text),
  })
  ctx.effect(() => () => { controller.dispose() }, 'tailscale: management reads')
  const t = ctx.locale.bind('tailscale')
  ctx.slots.inject('settings.section', () => {
    void controller.refresh()
    return ctx.slots.register({
      name: 'settings.section', id: 'tailscale', order: 80, locale: 'tailscale', label: () => t('title'),
      inject: (): RemoteAccessInjected => ({
        hooks: { tailscale: controller.view },
        refresh: () => controller.refresh(), start: () => controller.start(), stop: () => controller.stop(), copy: () => controller.copy(),
      }),
    }, RemoteAccessSection)
  })
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'tailscale.feedback', locale: 'tailscale',
    inject: (): RemoteAccessNoticeInjected => ({
      hooks: { tailscaleNotice: controller.notice }, dismissNotice: (id) => { controller.dismiss(id) },
    }),
  }, RemoteAccessNotice))
  ctx.on('connection/reset', () => { void controller.refresh() })
}
