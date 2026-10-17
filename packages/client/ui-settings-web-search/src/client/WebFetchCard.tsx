/**
 * The web-fetch provider's settings page: the `User-Agent` its anonymous
 * requests carry. The provider keeps no credentials, so this is the one field.
 */

import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { SettingsForm, SettingsValueField } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { formLabels } from './locales.ts'
import type { WebFetchCardFace } from './web-fetch-card-controller.ts'

/** Props the renderer binds for the web-fetch page. */
export type WebFetchCardProps =
  PropsRuntime<'plugins.item'>
  & PropsLocale<'settings.webSearch'>
  & InjectFace<WebFetchCardFace>

/**
 * Render the web-fetch provider's one-liner or its settings form, as the Plugins page asks.
 * @param props - the view asked for, locale copy, the form snapshot, and its actions.
 * @returns the one-liner, or the form.
 */
export function WebFetchCard(props: WebFetchCardProps) {
  const { t } = props
  const state = props.useWebFetchCard(snapshot => snapshot)
  if (props.view === 'summary') return t('fetchDescription')
  return (
    <SettingsForm labels={formLabels(t)} state={state} onSave={props.save} onDiscard={props.discard}>
      <SettingsValueField
        id="plugin-config-web-fetch-user-agent"
        label={t('userAgent')}
        hint={t('fetchUserAgentHint')}
        overriddenLabel={t('overridden')}
        resetLabel={t('reset')}
        invalidLabel={t('invalidNumber')}
        disabled={!state.writable}
        {...state.userAgent}
        onEdit={(text) => { props.edit('userAgent', text) }}
        onReset={() => { props.resetField('userAgent') }}
      />
    </SettingsForm>
  )
}
