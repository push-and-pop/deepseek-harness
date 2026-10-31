import { expect, it } from 'vitest'
import type { CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { TailscaleLink } from '../src/link-access.ts'

function store() {
  const records = new Map<string, CredentialRecord>()
  const credentials = {
    async modifyRecord(key: string, mutate: (value: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>) {
      const next = await mutate(records.get(key))
      if (next !== undefined) records.set(key, next)
      return records.get(key)
    },
  } as CredentialProvider
  return { records, credentials }
}

it('keeps the complete link stable across issuers but isolates profiles and exact origins', async () => {
  const { credentials, records } = store()
  const origin = 'https://pc.example.ts.net:8443'
  const first = await TailscaleLink.create(credentials, 'desktop')
  const second = await TailscaleLink.create(credentials, 'desktop')
  const other = await TailscaleLink.create(credentials, 'web')
  const url = new URL(first.url(origin))
  const token = url.searchParams.get('token') ?? ''
  expect(second.url(origin)).toBe(first.url(origin))
  expect(other.url(origin)).not.toBe(first.url(origin))
  expect(second.accepts(origin, token)).toBe(true)
  expect(other.accepts(origin, token)).toBe(false)
  expect(second.accepts('https://other.example.ts.net:8443', token)).toBe(false)
  expect(second.accepts('https://pc.example.ts.net:8444', token)).toBe(false)
  expect(second.accepts(origin, `${token}x`)).toBe(false)
  expect(second.accepts(origin, '')).toBe(false)
  expect(records.size).toBe(2)
})

it('refuses malformed saved credentials rather than silently replacing a stable link', async () => {
  const { credentials, records } = store()
  await TailscaleLink.create(credentials, 'desktop')
  for (const key of records.keys()) records.set(key, { kind: 'grant', payload: { version: 99, secret: 'invalid' } })
  await expect(TailscaleLink.create(credentials, 'desktop')).rejects.toThrow('link-storage-error')
  expect([...records.values()]).toEqual([{ kind: 'grant', payload: { version: 99, secret: 'invalid' } }])
})
