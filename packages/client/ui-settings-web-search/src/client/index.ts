/**
 * The web-search and web-fetch settings pages, browser half. The search page is
 * the switch between DeepSeek Messages search and the Search and Fetch APIs,
 * which writes the `web` provider selection, plus the selected API's key,
 * endpoint, and per-search limit — and, on the Messages side, the deployment's
 * attribution `User-Agent` and extra request headers. It registers into the
 * Plugins page's `plugins.item` slot while the Host serves
 * `web-search-deepseek`, so a deployment without that provider shows no trace
 * of it; the switch appears only while the Host also serves `web` and
 * `web-deepseek-api`. The fetch page edits the `web-fetch-http` provider's
 * `User-Agent` and appears only while that namespace is served as well.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms Context merge. Cross-plugin collaboration
// goes through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the Plugins page's SlotMap merge (the 'plugins.item' entry).
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { WebFetchCard } from './WebFetchCard.tsx'
import { WEB_FETCH_NS, WebFetchCardController } from './web-fetch-card-controller.ts'
import { WebSearchCard } from './WebSearchCard.tsx'
import { WEB_API_NS, WEB_NS, WEB_SEARCH_NS, WebSearchCardController } from './web-search-card-controller.ts'
import { en, zh, type WebSearchSettingsLocaleKey } from './locales.ts'

export type { WebFetchCardProps } from './WebFetchCard.tsx'
export type { WebFetchCardFace, WebFetchCardState, WebFetchSettings } from './web-fetch-card-controller.ts'
export type { WebSearchCardProps } from './WebSearchCard.tsx'
export type {
  WebApiSettings, WebProviderSelection, WebSearchCardFace, WebSearchCardScopes, WebSearchCardState, WebSearchSettings,
} from './web-search-card-controller.ts'
export type { WebSearchSettingsLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Web-search settings page copy. */
    'settings.webSearch': WebSearchSettingsLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.webSearch'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'remote', 'remote.credentials', 'configForms']

/**
 * Mount the web-search and web-fetch settings pages while the Host serves
 * their namespaces.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-web-search: dictionaries')
  const card = new WebSearchCardController({
    web: ctx.configForms.get(WEB_NS), messages: ctx.configForms.get(WEB_SEARCH_NS), api: ctx.configForms.get(WEB_API_NS),
  }, ctx)
  ctx.effect(() => () => { card.dispose() }, 'ui-settings-web-search: form subscription')
  // The credential the page reports is not part of any settings section, so
  // no scope publishes when one is written. This is the only signal
  // that a key written on another surface reached the Host.
  ctx.effect(
    () => ctx.remote.$on('credentials/reference-updated', (ref) => { card.refreshCredential(ref) }),
    'ui-settings-web-search: credential invalidations',
  )
  ctx.effect(() => ctx.configForms.whileServed([WEB_SEARCH_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'web-search', order: 20, label: () => t('title'), locale: NS, inject: () => card.inject(),
  }, WebSearchCard))), 'ui-settings-web-search: page')
  const fetchCard = new WebFetchCardController(ctx.configForms.get(WEB_FETCH_NS))
  ctx.effect(() => () => { fetchCard.dispose() }, 'ui-settings-web-search: fetch form subscription')
  ctx.effect(() => ctx.configForms.whileServed([WEB_FETCH_NS], () => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item', id: 'web-fetch', order: 21, label: () => t('fetchTitle'), locale: NS, inject: () => fetchCard.inject(),
  }, WebFetchCard))), 'ui-settings-web-search: fetch page')
}
