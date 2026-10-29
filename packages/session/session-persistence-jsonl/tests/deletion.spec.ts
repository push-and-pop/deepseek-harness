import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, access, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { SESSION_FORMAT_VERSION, SessionId, type SessionHeader } from '@deepseek-ai/dsh-session'
import * as JsonlPersistence from '../src/index.ts'
import { generationLogPath } from '../src/format.ts'

const roots: Context[] = []
const directories: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function backend(root: string, compression: 'none' | 'zstd' = 'none') {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(JsonlPersistence, { root, compression })
  return ctx.sessionPersistence
}

async function directory() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-jsonl-delete-'))
  directories.push(root)
  return root
}

for (const compression of ['none', 'zstd'] as const) {
  describe(`JSONL deletion (${compression})`, () => {
    it('removes every generation without resurrecting a predecessor or deleting another Session', async () => {
      const root = await directory()
      const storage = await backend(root, compression)
      const id = SessionId('erased')
      const header: SessionHeader = { version: SESSION_FORMAT_VERSION, id, isSeeded: false, createdAt: 1, cwd: root }
      const writer = await storage.create(header)
      await writer.flush()
      await writer.close()
      const reader = await storage.open(id, 'read')
      const predecessor = generationLogPath(root, root, id, SESSION_FORMAT_VERSION - 1, compression)
      await writeFile(predecessor, 'old generation')
      const kept = await storage.create({ ...header, id: SessionId('kept') })
      await kept.flush()
      await kept.close()
      expect(await storage.delete(id)).toBe(true)
      expect(await storage.stat(id)).toBeUndefined()
      expect((await storage.list()).map(row => row.header.id)).toEqual([SessionId('kept')])
      await expect(storage.open(id, 'read')).rejects.toMatchObject({ name: 'SessionPersistenceNotFoundError' })
      await expect(reader.read()).rejects.toMatchObject({ name: 'SessionPersistenceNotFoundError' })
      await reader.close()
      await expect(access(predecessor)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(dirname(predecessor))).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readdir(join(root, '_deleted'))).toEqual([])
      expect(await storage.delete(id)).toBe(false)
    })

    it('physically removes all requested directories but leaves unrelated Sessions intact', async () => {
      const root = await directory()
      const storage = await backend(root, compression)
      const ids = ['root', 'child', 'kept'].map(SessionId)
      for (const id of ids) {
        const writer = await storage.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false })
        await writer.flush()
        await writer.close()
      }
      const removed = await storage.deleteMany([ids[0]!, ids[1]!, ids[0]!, SessionId('missing')])
      expect(new Set(removed)).toEqual(new Set(ids.slice(0, 2)))
      expect((await storage.list()).map(row => row.header.id)).toEqual([ids[2]])
      expect(await readdir(join(root, '_deleted'))).toEqual([])
    })

    it('acquires every foreign writer lease before removing the first directory', async () => {
      const root = await directory()
      const storage = await backend(root, compression)
      const foreign = await backend(root, compression)
      const ids = ['a-root', 'z-child'].map(SessionId)
      for (const id of ids) {
        const writer = await storage.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false })
        await writer.flush()
        await writer.close()
      }
      const held = await foreign.open(ids[1]!, 'write')
      try {
        await expect(storage.deleteMany(ids)).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
        expect(await storage.stat(ids[0]!)).toBeDefined()
        expect(await storage.stat(ids[1]!)).toBeDefined()
      } finally { await held.close() }
      expect(new Set(await storage.deleteMany(ids))).toEqual(new Set(ids))
      expect(await storage.list()).toEqual([])
    })

    it('refuses local and foreign backend write ownership, then deletes after close', async () => {
      const root = await directory()
      const first = await backend(root, compression)
      const second = await backend(root, compression)
      const id = SessionId('owned')
      const writer = await first.create({ version: SESSION_FORMAT_VERSION, id, createdAt: 1, isSeeded: false })
      await expect(first.delete(id)).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
      await writer.flush()
      await expect(second.delete(id)).rejects.toMatchObject({ name: 'SessionAlreadyOwnedError' })
      expect(await first.stat(id)).toBeDefined()
      await writer.close()
      expect(await second.delete(id)).toBe(true)
      expect(await first.stat(id)).toBeUndefined()
    })
  })
}
