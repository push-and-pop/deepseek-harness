import { mkdtemp, mkdir, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { ApiSessionAgentController } from '../src/agent.ts'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function harness() {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-session-delete-'))
  directories.push(directory)
  const cwd = join(directory, 'workspace')
  await mkdir(cwd)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlPersistence, { root: join(directory, 'sessions'), compression: 'none' })
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const domain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', domain)
  ctx.provide('storageDomain', domain)
  await ctx.plugin(WorkspaceRegistry)
  const live = new Map<SessionId, Agent>()
  ctx.provide('agents', { get: (id: SessionId) => live.get(id) } as never)
  const controller = new ApiSessionAgentController(ctx)
  const workspace = await ctx.workspaceRegistry.create(cwd)
  const removed: SessionId[] = []
  ctx.on('api-session/removed', (id) => { removed.push(id) })
  async function stored(id: string, fields: Partial<SessionHeader> = {}) {
    const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 1, cwd, isSeeded: false, ...fields }
    const writer = await ctx.sessionPersistence.create(header)
    await writer.flush()
    await writer.close()
    await workspace.attachSession(header.id)
    return header
  }
  return { ctx, controller, workspace, cwd, live, stored, removed }
}

describe('permanent Session deletion', () => {
  it('erases a cold log, workspace membership and pin, and publishes removal', async () => {
    const h = await harness()
    const header = await h.stored('cold')
    const before = await h.ctx.sessionPersistence.stat(header.id)
    await h.ctx.workspaceRegistry.pinSession(header.id)
    await h.controller.deleteSession(header.id)
    expect(await h.ctx.sessionPersistence.stat(header.id)).toBeUndefined()
    expect(await h.ctx.sessionPersistence.list()).toEqual([])
    await expect(access(before!.location!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.workspace.sessionIds).toEqual([])
    expect(h.ctx.workspaceRegistry.pinnedSessionIds).toEqual([])
    expect(h.removed).toEqual([header.id])
    await expect(h.controller.deleteSession(header.id)).rejects.toMatchObject({ code: 'session/not-found' })
  })

  it('erases archived rows and retains unrelated Sessions', async () => {
    const h = await harness()
    const target = await h.stored('target')
    const kept = await h.stored('kept')
    await h.ctx.workspaceRegistry.archiveSession(target.id)
    await h.controller.deleteSession(target.id)
    expect(h.ctx.workspaceRegistry.archivedSessionIds).toEqual([])
    expect(h.workspace.sessionIds).toEqual([kept.id])
    expect((await h.ctx.sessionPersistence.list()).map(row => row.header.id)).toEqual([kept.id])
  })

  it('deletes a complete multilevel subagent tree but preserves independent forks', async () => {
    const h = await harness()
    const parent = await h.stored('parent')
    const child = await h.stored('child', { parentSession: parent.id, origin: 'subagent' })
    const grandchild = await h.stored('grandchild', { parentSession: child.id, origin: 'subagent' })
    const fork = await h.stored('fork', { parentSession: parent.id })
    const paths = await Promise.all([parent.id, child.id, grandchild.id].map(id => h.ctx.sessionPersistence.stat(id)))
    await expect(h.controller.deleteSession(child.id)).rejects.toMatchObject({ code: 'session/delete-busy' })
    await h.controller.deleteSession(parent.id)
    expect(new Set(h.removed)).toEqual(new Set([parent.id, child.id, grandchild.id]))
    expect((await h.ctx.sessionPersistence.list()).map(row => row.header.id)).toEqual([fork.id])
    for (const stored of paths) await expect(access(stored!.location!.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.workspace.sessionIds).toEqual([fork.id])
  })

  it('refuses a busy descendant before deleting any member', async () => {
    const h = await harness()
    const root = await h.stored('root')
    const child = await h.stored('child', { parentSession: root.id, origin: 'subagent' })
    h.ctx.on('workspace/session-activity', async ({ sessionId }, next) => sessionId === child.id ? [{ kind: 'turn' }] : next())
    await expect(h.controller.deleteSession(root.id)).rejects.toMatchObject({ code: 'session/delete-busy' })
    expect(await h.ctx.sessionPersistence.list()).toHaveLength(2)
    expect(h.removed).toEqual([])
  })

  it('refuses a foreign writer on a later descendant without deleting the earlier root', async () => {
    const h = await harness()
    const root = await h.stored('a-root')
    const child = await h.stored('z-child', { parentSession: root.id, origin: 'subagent' })
    const writer = await h.ctx.sessionPersistence.open(child.id, 'write')
    try {
      await expect(h.controller.deleteSession(root.id)).rejects.toMatchObject({ code: 'session/writer-held' })
      expect(await h.ctx.sessionPersistence.stat(root.id)).toBeDefined()
      expect(await h.ctx.sessionPersistence.stat(child.id)).toBeDefined()
      expect(h.removed).toEqual([])
    } finally { await writer.close() }
    await h.controller.deleteSession(root.id)
    expect(await h.ctx.sessionPersistence.list()).toEqual([])
  })

  it('requires authorization for every descendant before releasing or deleting anything', async () => {
    const h = await harness()
    const root = await h.stored('authorized-root')
    const child = await h.stored('private-child', { parentSession: root.id, origin: 'subagent' })
    const failure = h.controller.deleteSession(root.id, id => id === root.id)
    await expect(failure).rejects.toMatchObject({ code: 'remote-access/denied' })
    expect(await h.ctx.sessionPersistence.stat(root.id)).toBeDefined()
    expect(await h.ctx.sessionPersistence.stat(child.id)).toBeDefined()
    expect(h.removed).toEqual([])
  })

  it('releases idle children through their owner before deleting their storage', async () => {
    const h = await harness()
    const root = await h.stored('live-root')
    const child = await h.stored('live-child', { parentSession: root.id, origin: 'subagent' })
    const rootWriter = await h.ctx.sessionPersistence.open(root.id, 'write')
    const childWriter = await h.ctx.sessionPersistence.open(child.id, 'write')
    const rootSession = h.ctx.sessions.prepare(root.id, { meta: root })
    const childSession = h.ctx.sessions.prepare(child.id, { meta: child })
    const detachRoot = h.ctx.sessions.enter(rootSession)
    const detachChild = h.ctx.sessions.enter(childSession)
    h.ctx.sessions.announce(rootSession)
    h.ctx.sessions.announce(childSession)
    const rootAgent = { id: root.id, session: rootSession, status: 'idle', ctx: h.ctx } as Agent
    const childAgent = { id: child.id, session: childSession, status: 'idle', ctx: h.ctx } as Agent
    h.live.set(root.id, rootAgent)
    h.live.set(child.id, childAgent)
    h.controller.own({ agent: rootAgent, dispose: async () => { await rootWriter.close(); detachRoot(); h.live.delete(root.id) } })
    const drainDescendants = vi.fn(async () => { await childWriter.close(); detachChild(); h.live.delete(child.id) })
    h.ctx.provide('subagents', { drainDescendants } as never)
    await h.controller.deleteSession(root.id)
    expect(drainDescendants).toHaveBeenCalledWith([rootAgent], { idleOnly: true })
    expect(await h.ctx.sessionPersistence.list()).toEqual([])
    expect(h.ctx.sessions.list()).toEqual([])
  })

  it('refuses activity, foreign writers and unowned live Sessions before destruction', async () => {
    const h = await harness()
    const header = await h.stored('busy')
    const stop = h.ctx.on('workspace/session-activity', async (_request, next) => [{ kind: 'turn' }, ...await next()])
    await expect(h.controller.deleteSession(header.id)).rejects.toMatchObject({ code: 'session/delete-busy' })
    stop()
    const writer = await h.ctx.sessionPersistence.open(header.id, 'write')
    await expect(h.controller.deleteSession(header.id)).rejects.toMatchObject({ code: 'session/writer-held' })
    await writer.close()
    h.ctx.sessions.create(header.id, { meta: header })
    await expect(h.controller.deleteSession(header.id)).rejects.toMatchObject({ code: 'session/delete-busy' })
    expect(await h.ctx.sessionPersistence.stat(header.id)).toBeDefined()
    expect(h.workspace.sessionIds).toEqual([header.id])
  })

  it('awaits its owned Agent disposal before acquiring deletion ownership', async () => {
    const h = await harness()
    const header = await h.stored('live')
    const writer = await h.ctx.sessionPersistence.open(header.id, 'write')
    const session = h.ctx.sessions.prepare(header.id, { meta: header })
    const detach = h.ctx.sessions.enter(session)
    h.ctx.sessions.announce(session)
    const agent = { id: header.id, session, status: 'idle', ctx: h.ctx } as Agent
    h.live.set(header.id, agent)
    const dispose = vi.fn(async () => { await writer.close(); detach(); h.live.delete(header.id) })
    h.controller.own({ agent, dispose })
    await h.controller.deleteSession(header.id)
    expect(dispose).toHaveBeenCalledOnce()
    expect(h.ctx.sessions.get(header.id)).toBeUndefined()
    expect(h.live.get(header.id)).toBeUndefined()
    expect(await h.ctx.sessionPersistence.stat(header.id)).toBeUndefined()
  })

  it('commits removal despite interrupted Workspace cleanup and retries its journal', async () => {
    const h = await harness()
    const header = await h.stored('cleanup')
    vi.spyOn(h.workspace, 'detachSession').mockRejectedValueOnce(new Error('medium unavailable'))
    await expect(h.controller.deleteSession(header.id)).resolves.toBeUndefined()
    expect(h.removed).toEqual([header.id])
    await h.ctx.workspaceRegistry.unpinSession(header.id)
    expect(h.workspace.sessionIds).toEqual([])
    expect(h.ctx.workspaceRegistry.archivedSessionIds).toEqual([])
  })
})
