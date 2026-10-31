/** Remote-access settings use injected snapshots and actions, never a transport or context. */
import { useMemo } from 'react'
import { makeLinkQr } from './qr-code.ts'
import { Button, StateDot, Toast } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { TailscaleClient } from './controller.ts'
import { errorKey } from './controller.ts'
import css from './RemoteAccessSection.module.css'

/** The page's private sources and user-only actions. */
export interface RemoteAccessInjected {
  readonly hooks: { readonly tailscale: TailscaleClient['view'] }
  refresh(): Promise<void>
  start(): Promise<void>
  stop(): Promise<void>
  copy(): Promise<void>
}

/** Complete props are derived from the settings owner, locale, and injection. */
export type RemoteAccessProps = PropsRuntime<'settings.section'> & PropsLocale<'tailscale'> & InjectFace<RemoteAccessInjected>

/** Render setup instructions, authoritative state, and explicit management controls.
 * @param props Framework-bound status and callbacks.
 * @returns The mobile-friendly settings section.
 */
export function RemoteAccessSection({ t, useTailscale, refresh, start, stop, copy }: RemoteAccessProps) {
  const { status, pending, failure, localOnly } = useTailscale(value => value)
  const busy = pending !== undefined
  const running = status?.state === 'running'
  const qrLink = running && !localOnly && failure === undefined && (pending === undefined || pending === 'copy')
    ? status.url : undefined
  const qr = useMemo(() => qrLink === undefined ? undefined : makeLinkQr(qrLink), [qrLink])
  return (
    <section className={css.section} aria-label={t('title')} aria-busy={busy}>
      <p className={css.description}>{t('description')}</p>
      <div className={css.card}>
        <h3 className={css.heading}>{t('setup.title')}</h3>
        <ol className={css.steps}>
          <li>{t('setup.pc')}</li>
          <li>{t('setup.phone')}</li>
          <li>{t('setup.finish')}</li>
        </ol>
        <a className={css.link} href="https://tailscale.com/download" target="_blank" rel="noreferrer">{t('setup.download')}</a>
        <p className={css.secondary}>{t('setup.https')}</p>
        <a className={css.link} href="https://login.tailscale.com/admin/dns" target="_blank" rel="noreferrer">{t('setup.dns')}</a>
      </div>
      <div className={css.card}>
        <h3 className={css.heading}>{t('status.title')}</h3>
        {localOnly ? <p role="status">{t('localOnly')}</p> : <>
          {status === undefined && busy ? <div className={css.loading}><StateDot state="ongoing" /></div> : status !== undefined && <>
            <p className={css.state} role="status">
              <StateDot state={status.state === 'running' ? 'done' : status.state === 'error' ? 'error' : 'idle'} />
              {t(`status.${status.state}`)}
            </p>
            {status.dnsName !== undefined && <p className={css.device}>{t('status.device', { name: status.dnsName })}</p>}
          </>}
          <div className={css.notice} aria-live="polite">
            {failure !== undefined
              ? <p role="alert">{t(failure === 'query' ? 'error.query' : 'error.operation')}</p>
              : status?.state === 'error' && <p role="alert">{t(errorKey(status.code))}</p>}
          </div>
          <div className={css.actions}>
            <Button variant="outline" disabled={busy} onClick={() => { void refresh() }}>{t('refresh')}</Button>
            <Button variant={running ? 'outline' : 'primary'} disabled={busy || (!running && (failure !== undefined || status?.state !== 'ready'))}
              onClick={() => { void (running ? stop() : start()) }}>{t(running ? 'stop' : 'start')}</Button>
            {running && <Button variant="outline" disabled={busy || failure !== undefined || status.url === undefined}
              onClick={() => { void copy() }}>{t('copy')}</Button>}
          </div>
          {qrLink !== undefined && <div className={css.qrBlock}>
            <h4 className={css.heading}>{t('qr.title')}</h4>
            {qr === undefined ? <p role="alert">{t('qr.error')}</p> : <svg
              className={css.qrCode} role="img" aria-label={t('qr.label')} focusable="false"
              viewBox={`0 0 ${qr.size} ${qr.size}`} width="280" height="280" shapeRendering="crispEdges">
              <rect width={qr.size} height={qr.size} fill="#fff" />
              <path d={qr.path} fill="#000" />
            </svg>}
            <p className={css.secondary}>{t('qr.hint')}</p>
            <p className={css.secondary}>{t('qr.warning')}</p>
          </div>}
        </>}
      </div>
      <p className={css.secondary}>{t('lifetime')}</p>
      <p className={css.secondary}>{t('security')}</p>
    </section>
  )
}

/** Toast source is held by the plugin, outside the settings panel lifetime. */
export interface RemoteAccessNoticeInjected {
  readonly hooks: { readonly tailscaleNotice: TailscaleClient['notice'] }
  dismissNotice(id: number): void
}

/** Framework-derived root overlay props. */
export type RemoteAccessNoticeProps = PropsRuntime<'shell.overlay'> & PropsLocale<'tailscale'> & InjectFace<RemoteAccessNoticeInjected>

/** Render localized action feedback even after settings closes.
 * @param props Notice snapshot and its instance-aware dismissal.
 * @returns A toast, or nothing while idle.
 */
export function RemoteAccessNotice({ t, useTailscaleNotice, dismissNotice }: RemoteAccessNoticeProps) {
  const notice = useTailscaleNotice(value => value)
  return notice === undefined ? null : <Toast key={notice.id} text={t(notice.key)}
    {...notice.success ? { tone: 'success' as const } : {}} onDone={() => { dismissNotice(notice.id) }} />
}
