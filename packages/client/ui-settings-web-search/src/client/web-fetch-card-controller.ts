/**
 * The web-fetch page's staged form over the `web-fetch-http` settings
 * namespace: the `User-Agent` the anonymous fetch provider sends on every
 * request. Unlike the search page there is no credential control — the
 * provider is anonymous by design, so the section is the whole form.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import {
  SettingsFormModel, settingsTextField,
  type SettingsFieldState, type SettingsFormActions, type SettingsFormShell, type SettingsFormScope,
} from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Namespace of the anonymous HTTP fetch provider. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const WEB_FETCH_NS = 'web-fetch-http'

/** The fetch-provider fields this page edits. */
export interface WebFetchSettings {
  /** `User-Agent` header sent on every fetched request. */
  userAgent?: string
}

/** What the web-fetch page renders. */
export interface WebFetchCardState extends SettingsFormShell {
  /** The staged `User-Agent`. */
  userAgent: SettingsFieldState
}

/** The registration-side face the web-fetch page's slot entry injects. */
export interface WebFetchCardFace extends SettingsFormActions {
  hooks: {
    /** Page snapshot bound by the renderer as useWebFetchCard. */
    webFetchCard: SnapshotStore<WebFetchCardState>
  }
}

/** Bridges the `web-fetch-http` scope onto the page. */
export class WebFetchCardController {
  private readonly form: SettingsFormModel<WebFetchSettings>
  private readonly store: SnapshotStore<WebFetchCardState>

  /**
   * @param scope - the bound settings scope for the `web-fetch-http` namespace.
   */
  constructor(scope: SettingsFormScope<WebFetchSettings>) {
    this.form = new SettingsFormModel(scope, [settingsTextField('userAgent')])
    this.store = this.form.bind(() => this.projection())
  }

  /**
   * Build the face the page's slot registration injects.
   * @returns the snapshot hook and form actions the renderer binds.
   */
  inject(): WebFetchCardFace {
    return { hooks: { webFetchCard: this.store }, ...this.form.actions() }
  }

  /** Release configuration subscriptions. */
  dispose(): void { this.form.dispose() }

  private projection(): WebFetchCardState {
    return {
      ...this.form.shell(),
      userAgent: this.form.field('userAgent'),
    }
  }
}
