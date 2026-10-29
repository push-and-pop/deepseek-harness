/** Permanent Session deletion: menu request followed by an explicit confirmation. */
import { useRef, useState } from 'react'
import type { WorkspaceSessionDeleteError } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { Button, IconTrashOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  DeleteSessionInjected, SessionDeleteConfirmInjected, SessionDeleteConfirmProps, SessionDeleteTarget, SessionMenuItemProps,
} from '../contract/slots.ts'
import css from '../rows/WorkspaceBrowser.module.css'

/**
 * Destructive menu row immediately after Archive; choosing it only opens a dialog.
 * @param props - target row, access seat, menu state, and confirmation request.
 * @returns the menu row, or nothing when access is denied.
 */
export function DeleteSessionMenuItem({
  sessionId, displayTitle, useMenuOpenState, useSessionAccess, requestSessionDelete, t,
}: SessionMenuItemProps<DeleteSessionInjected>) {
  const [, setMenuOpen] = useMenuOpenState()
  if (!useSessionAccess(sessionId, 'workspace/deleteSession')) return null
  return (
    <MenuItemButton danger icon={<IconTrashOutlineRegular size={14} />} onSelect={() => {
      setMenuOpen(false)
      requestSessionDelete(sessionId, displayTitle)
    }}>
      {t('menu.deleteSession')}
    </MenuItemButton>
  )
}

/**
 * Frame-wide confirmation that survives the invoking menu's unmount.
 * @param props - pending request, settlement, Host operation, and localized copy.
 * @returns the confirmation, or nothing when no deletion was requested.
 */
export function SessionDeleteConfirmDialog({
  useDeleteRequest, settleSessionDelete, deleteSession, t,
}: SessionDeleteConfirmProps) {
  const request = useDeleteRequest(value => value)
  if (request === null) return null
  return <DeleteConfirmForm key={request.sessionId} request={request} deleteSession={deleteSession} onSettle={settleSessionDelete} t={t} />
}

/** Known Host refusals have actionable localized messages; other failures retain diagnostics. */
function deleteFailureMessage(reason: unknown, t: SessionDeleteConfirmProps['t']): string {
  if (reason instanceof Error && reason.name === 'WorkspaceSessionDeleteError') {
    const { rpcError } = reason as WorkspaceSessionDeleteError
    switch (rpcError.code) {
      case 'session/delete-busy': return t('delete.session.busy')
      case 'session/has-children': return t('delete.session.children')
      case 'session/writer-held': return t('delete.session.writerHeld')
      case 'session/not-found': return t('delete.session.notFound')
      // Remote failures are merge-extensible; retain diagnostics for other providers and transport errors.
      default: break
    }
  }
  return t('delete.session.failed', { message: reason instanceof Error ? reason.message : String(reason) })
}

/** One target's pending operation and error state; deletion cannot be submitted twice. */
function DeleteConfirmForm({ request, deleteSession, onSettle, t }: {
  request: SessionDeleteTarget
  deleteSession: SessionDeleteConfirmInjected['deleteSession']
  onSettle: () => void
  t: SessionDeleteConfirmProps['t']
}) {
  const inFlight = useRef(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => {
    if (!inFlight.current) onSettle()
  }
  const confirm = async () => {
    if (inFlight.current) return
    inFlight.current = true
    setDeleting(true)
    setError(null)
    try {
      await deleteSession(request.sessionId)
    } catch (reason: unknown) {
      inFlight.current = false
      setDeleting(false)
      setError(deleteFailureMessage(reason, t))
      return
    }
    inFlight.current = false
    onSettle()
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('delete.session.title')}
      description={t('delete.session.desc', { title: request.displayTitle || t('session.untitled') })}
      footer={(
        <>
          <Button variant="outline" data-modal-autofocus disabled={deleting} onClick={close}>{t('cancel')}</Button>
          <Button variant="outline" className={css.deleteAction} disabled={deleting} onClick={() => { void confirm() }}>
            {t('delete.session.action')}
          </Button>
        </>
      )}
    >
      {deleting && <div className={css.deleteStatus} role="status">{t('delete.session.pending')}</div>}
      {error !== null && <div className={css.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
