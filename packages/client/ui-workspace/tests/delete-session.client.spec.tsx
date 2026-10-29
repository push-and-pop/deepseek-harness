// @vitest-environment jsdom
/** Delete requires a second explicit gesture and retains a failed confirmation for retry. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { GlobalStandardProps, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { allowAllAccess, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { DeleteSessionInjected, SessionDeleteConfirmProps, SessionMenuItemProps } from '../src/client/contract/slots.ts'
import { DeleteSessionMenuItem, SessionDeleteConfirmDialog } from '../src/client/session-actions/DeleteSession.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const sessionId = 'delete-target' as SessionId
const request = { sessionId, displayTitle: '待删除会话' }
const t: PropsLocale<'workspace'>['t'] = makeTranslate(zh, commonZh)
const standard: GlobalStandardProps = {
  ...allowAllAccess,
  useSessions: () => { throw new Error('unused') },
  useSessionStatus: () => { throw new Error('unused') },
  useSessionRetainInfo: () => undefined,
  usePanelInfo: () => { throw new Error('unused') },
  useWorkspaces: () => { throw new Error('unused') },
  useResource: () => { throw new Error('unused') },
}
function dialogProps(): SessionDeleteConfirmProps {
  return {
    ...standard, t,
    useDeleteRequest: select => select(request),
    settleSessionDelete: vi.fn(),
    deleteSession: vi.fn(async () => {}),
  }
}

describe('delete Session confirmation', () => {
  it('closes the menu before requesting confirmation and gates the row on access', () => {
    const closeMenu = vi.fn()
    const requestSessionDelete = vi.fn()
    const props: SessionMenuItemProps<DeleteSessionInjected> = {
      ...standard, ...request, t, requestSessionDelete,
      useMenuOpenState: () => [true, closeMenu] as const,
      useShortcuts: selector => selector([]),
    }
    const view = render(<DeleteSessionMenuItem {...props} />)
    fireEvent.click(screen.getByRole('menuitem', { name: '删除会话' }))
    expect(closeMenu).toHaveBeenCalledWith(false)
    expect(requestSessionDelete).toHaveBeenCalledWith(sessionId, request.displayTitle)
    expect(closeMenu.mock.invocationCallOrder[0]).toBeLessThan(requestSessionDelete.mock.invocationCallOrder[0]!)
    const useSessionAccess = vi.fn(() => false)
    view.rerender(<DeleteSessionMenuItem {...props} useSessionAccess={useSessionAccess} />)
    expect(useSessionAccess).toHaveBeenCalledWith(sessionId, 'workspace/deleteSession')
    expect(screen.queryByRole('menuitem')).toBeNull()
  })

  it('renders nothing until requested; cancel and Escape never invoke deletion', () => {
    const props = dialogProps()
    const view = render(<SessionDeleteConfirmDialog {...props} useDeleteRequest={select => select(null)} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    view.rerender(<SessionDeleteConfirmDialog {...props} />)
    expect(screen.getByRole('dialog').textContent).toContain('待删除会话')
    expect(screen.getByRole('dialog').textContent).toContain('此操作无法撤销')
    expect(screen.getByRole('dialog').textContent).toContain('及其全部子会话')
    expect(screen.getByRole('dialog').textContent).toContain('工作区里的代码、文档和生成文件均会保留')
    expect(props.deleteSession).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.settleSessionDelete).toHaveBeenCalledTimes(2)
    expect(props.deleteSession).not.toHaveBeenCalled()
  })

  it('deletes only the confirmed id, blocks repeated clicks and dismissal while pending, then closes', async () => {
    const props = dialogProps()
    let finish!: () => void
    props.deleteSession = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
    render(<SessionDeleteConfirmDialog {...props} />)
    const confirm = screen.getByRole('button', { name: '确认删除' })
    fireEvent.click(confirm)
    fireEvent.click(confirm)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(props.deleteSession).toHaveBeenCalledExactlyOnceWith(sessionId)
    expect(props.settleSessionDelete).not.toHaveBeenCalled()
    expect(screen.getByRole('status').textContent).toBe('正在删除会话…')
    expect((confirm as HTMLButtonElement).disabled).toBe(true)
    await act(async () => { finish() })
    expect(props.settleSessionDelete).toHaveBeenCalledOnce()
  })

  it.each([
    ['session/delete-busy', '此会话或其子会话仍有运行任务或正被其他功能使用，请停止任务后重试。'],
    ['session/has-children', '无法安全删除此会话及其子会话，请停止相关工作后重试。'],
    ['session/writer-held', '此会话或其子会话正被其他进程占用，请关闭相关会话后重试。'],
    ['session/not-found', '会话已不存在，请关闭此对话框并刷新会话列表。'],
    ['gateway/internal', '删除失败：internal failure'],
  ])('localizes the Host refusal %s without deleting or dismissing again', async (code, message) => {
    const props = dialogProps()
    const refusal = Object.assign(new Error('internal failure'), {
      name: 'WorkspaceSessionDeleteError', rpcError: { code, message: 'internal failure', details: {} },
    })
    props.deleteSession = vi.fn().mockRejectedValue(refusal)
    render(<SessionDeleteConfirmDialog {...props} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认删除' })) })
    expect(screen.getByRole('alert').textContent).toBe(message)
    expect(props.settleSessionDelete).not.toHaveBeenCalled()
  })

  it('keeps errors visible, allows retry, and resets state when the target changes', async () => {
    const props = dialogProps()
    props.deleteSession = vi.fn().mockRejectedValueOnce(new Error('Session is active')).mockResolvedValueOnce(undefined)
    const view = render(<SessionDeleteConfirmDialog {...props} />)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认删除' })) })
    expect(screen.getByRole('alert').textContent).toBe('删除失败：Session is active')
    expect(props.settleSessionDelete).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认删除' })) })
    expect(props.settleSessionDelete).toHaveBeenCalledOnce()
    view.rerender(<SessionDeleteConfirmDialog {...props} useDeleteRequest={select => select({ sessionId: 'another' as SessionId, displayTitle: '' })} />)
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('dialog').textContent).toContain('未命名')
  })
})
