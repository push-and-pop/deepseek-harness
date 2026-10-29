/** Real profile: delete removes only the selected Session's storage, never Workspace files. */
import { readFile, writeFile, access } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, type SessionHeader } from '@deepseek-ai/dsh-session'
import { chromium } from 'playwright'
import { expect, it, onTestFailed, onTestFinished } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, seedSession, watchConsole, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))

/** Cold lineage fixtures use actual Session storage without claiming a live Agent lifecycle. */
async function storeRelatedSession(
  scaffold: WebScaffold, parentSession: SessionId, id: string,
  options: { readonly cwd?: string; readonly depth?: number; readonly independentFork?: boolean } = {},
): Promise<SessionId> {
  const header: SessionHeader = {
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: Date.now(),
    isSeeded: options.independentFork === true,
    cwd: options.cwd ?? scaffold.workspaceCwd,
    parentSession,
    ...(options.independentFork === true ? {} : { origin: 'subagent' as const, delegationDepth: options.depth ?? 1 }),
  }
  const writer = await scaffold.ctx.sessionPersistence.create(
    header, options.independentFork === true ? { inheritedEventCount: SessionLogOffset(0) } : undefined,
  )
  try { await writer.flush() } finally { await writer.close() }
  return header.id
}

it('physically deletes a multilevel subagent tree while retaining independent forks and other storage', async () => {
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const fixture = await readFile(SEED, 'utf8')
  const root = await seedSession(scaffold, fixture, 'session-delete-tree-root')
  const kept = await seedSession(scaffold, fixture, 'session-delete-tree-kept')
  await workspace.attachSession(root)
  await workspace.attachSession(kept)
  const child = await storeRelatedSession(scaffold, root, 'session-delete-tree-child')
  const grandchild = await storeRelatedSession(scaffold, child, 'session-delete-tree-grandchild', {
    cwd: join(scaffold.workspaceCwd, 'different-child-directory'), depth: 2,
  })
  const fork = await storeRelatedSession(scaffold, root, 'session-delete-independent-fork', { independentFork: true })
  const selected = await Promise.all([root, child, grandchild].map(id => scaffold.ctx.sessionPersistence.stat(id)))
  const retained = await Promise.all([kept, fork].map(id => scaffold.ctx.sessionPersistence.stat(id)))
  const removed: SessionId[] = []
  scaffold.ctx.on('api-session/removed', (id, permanentlyDeleted) => { if (permanentlyDeleted === true) removed.push(id) })
  const workspaceFile = join(scaffold.workspaceCwd, 'tree-delete-keeps-project.txt')
  await writeFile(workspaceFile, 'The workspace is not Session storage')

  await scaffold.ctx.workspaceController.deleteSession({ sessionId: root })

  for (const stored of selected) await expect(access(stored!.location!.path)).rejects.toMatchObject({ code: 'ENOENT' })
  for (const stored of retained) await expect(access(stored!.location!.path)).resolves.toBeUndefined()
  expect(new Set(removed)).toEqual(new Set([root, child, grandchild]))
  expect((await scaffold.ctx.sessionPersistence.list()).map(entry => entry.header.id).sort()).toEqual([kept, fork].sort())
  expect(await readFile(workspaceFile, 'utf8')).toBe('The workspace is not Session storage')
}, 30_000)

it('physically removes only the selected Session storage through mounted Host controllers', async () => {
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const fixture = await readFile(SEED, 'utf8')
  const id = await seedSession(scaffold, fixture, 'session-delete-mounted-host')
  const kept = await seedSession(scaffold, fixture, 'session-delete-mounted-kept')
  await workspace.attachSession(id)
  await workspace.attachSession(kept)
  await scaffold.ctx.workspaceRegistry.pinSession(id)
  const selectedStorage = await scaffold.ctx.sessionPersistence.stat(id)
  const keptStorage = await scaffold.ctx.sessionPersistence.stat(kept)
  expect(selectedStorage?.location?.path).toBeDefined()
  expect(keptStorage?.location?.path).toBeDefined()
  const workspaceFile = join(scaffold.workspaceCwd, 'workspace-must-remain.txt')
  await writeFile(workspaceFile, 'Do not delete project files')
  const removed: string[] = []
  scaffold.ctx.on('api-session/removed', (sessionId) => { removed.push(sessionId) })

  await expect(scaffold.ctx.workspaceController.deleteSession({ sessionId: id })).resolves.toBeUndefined()

  expect(await scaffold.ctx.sessionPersistence.stat(id)).toBeUndefined()
  await expect(access(selectedStorage!.location!.path)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(access(keptStorage!.location!.path)).resolves.toBeUndefined()
  expect(await readFile(workspaceFile, 'utf8')).toBe('Do not delete project files')
  expect(workspace.sessionIds).not.toContain(id)
  expect(workspace.sessionIds).toContain(kept)
  expect(scaffold.ctx.workspaceRegistry.pinnedSessionIds).not.toContain(id)
  expect(removed).toContain(id)
}, 30_000)

it('deletes only after confirmation, removes pinned and archived membership, and stays deleted after reload', async () => {
  const scaffold = await launchWebScaffold({})
  onTestFinished(() => scaffold.close())
  const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
  const id = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'session-delete-web-e2e')
  const other = await seedSession(scaffold, await readFile(SEED, 'utf8'), 'session-delete-kept-web-e2e')
  await workspace.attachSession(id)
  await workspace.attachSession(other)
  await scaffold.ctx.sessionController.rename({ sessionId: id, title: 'Delete target' })
  await scaffold.ctx.sessionController.rename({ sessionId: other, title: 'Keep this session' })
  await scaffold.ctx.workspaceRegistry.pinSession(id)
  const child = await storeRelatedSession(scaffold, id, 'session-delete-browser-child')
  const grandchild = await storeRelatedSession(scaffold, child, 'session-delete-browser-grandchild', { depth: 2 })
  const childStorage = await scaffold.ctx.sessionPersistence.stat(child)
  const grandchildStorage = await scaffold.ctx.sessionPersistence.stat(grandchild)
  const selectedStorage = await scaffold.ctx.sessionPersistence.stat(id)
  const keptStorage = await scaffold.ctx.sessionPersistence.stat(other)
  const workspaceFile = join(scaffold.workspaceCwd, 'preserved-project-file.txt')
  await writeFile(workspaceFile, 'keep this project file')
  const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
  const browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
  try {
    const page = await newEnglishPage(browser)
    const console = watchConsole(page)
    onTestFailed(() => saveFailureShot(page, 'web-e2e-session-delete'))
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    const row = page.getByRole('treeitem').filter({ has: page.getByText('Delete target', { exact: true }) })
    await row.waitFor({ timeout: 20_000 })
    const openDelete = async () => {
      await row.hover()
      await row.getByRole('button', { name: 'Session actions for Delete target', exact: true }).click()
      const archive = page.getByRole('menuitem', { name: 'Archive session', exact: true })
        .or(page.getByRole('menuitem', { name: 'Unarchive session', exact: true }))
      const nextLabel = await archive.evaluate((element) => {
        const items = [...document.querySelectorAll('[role="menuitem"]')]
        return items[items.indexOf(element) + 1]?.textContent
      })
      expect(nextLabel).toBe('Delete session')
      await page.getByRole('menuitem', { name: 'Delete session', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'Delete this session?' })
      await dialog.waitFor()
      expect(await dialog.textContent()).toContain('all its child sessions')
    }
    await openDelete()
    await expect(access(selectedStorage!.location!.path)).resolves.toBeUndefined()
    await page.getByRole('button', { name: 'Cancel', exact: true }).click()
    await expect(access(selectedStorage!.location!.path)).resolves.toBeUndefined()
    await expect(access(childStorage!.location!.path)).resolves.toBeUndefined()
    await expect(access(grandchildStorage!.location!.path)).resolves.toBeUndefined()
    await openDelete()
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
    await expect(access(selectedStorage!.location!.path)).resolves.toBeUndefined()

    await scaffold.ctx.workspaceRegistry.archiveSession(id)
    await page.getByRole('button', { name: 'View options', exact: true }).click()
    await page.getByRole('menuitem', { name: 'All conversations (show archived)', exact: true }).click()
    await row.waitFor()
    await openDelete()
    await page.getByRole('button', { name: 'Confirm deletion', exact: true }).click()
    await expect.poll(() => row.count()).toBe(0)
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0)
    expect((await scaffold.ctx.sessionPersistence.list()).map(entry => entry.header.id)).not.toContain(id)
    await expect(access(selectedStorage!.location!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(childStorage!.location!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(grandchildStorage!.location!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(keptStorage!.location!.path)).resolves.toBeUndefined()
    expect(await readFile(workspaceFile, 'utf8')).toBe('keep this project file')
    expect((await scaffold.ctx.sessionPersistence.list()).map(entry => entry.header.id)).toContain(other)
    expect(scaffold.ctx.workspaceRegistry.archivedSessionIds).not.toContain(id)
    expect(scaffold.ctx.workspaceRegistry.pinnedSessionIds).not.toContain(id)
    expect(workspace.sessionIds).not.toContain(id)
    expect(workspace.sessionIds).toContain(other)

    const warningStart = console.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.getByText('Keep this session', { exact: true }).waitFor({ timeout: 20_000 })
    acknowledgeReloadConnectionLoss(console, warningStart)
    expect(await row.count()).toBe(0)
    expect(console.pageErrors).toEqual([])
    expect(console.warnings).toEqual([])
  } finally {
    await browser.close()
  }
}, 120_000)
