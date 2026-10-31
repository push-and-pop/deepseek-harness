/** Deep state recovery, bounded fact validation, and durable context admission. */
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createToolResultMessage, MessageId, ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { expect, it, onTestFinished, vi } from 'vitest'

interface Fact { text: string; tag?: string }
interface StateReader {
  facts(session: Session): Fact[]
  paging(session: Session): { active: string[] }
  context(session: Session): { stepCount: number }
  published(session: Session, kind: string): { text: string; visible: boolean } | undefined
}
interface StateModule {
  name: string
  inject: string[]
  Config: Schemastery<Record<string, number>, { maxFactChars: number }>
  apply(ctx: Context, input?: Record<string, number>): Promise<void>
  createDeepStateDefinition(config: object): { key: string }
}
interface LedgerModule {
  name: string
  inject: string[]
  apply(ctx: Context): void
  renderLedgerField(facts: Fact[]): string | undefined
}
interface WorkingModule {
  name: string
  inject: string[]
  apply(ctx: Context, config?: Record<string, number>): void
  renderWorkingContext(snapshot: {
    plan: { seen: boolean; active: boolean }
    active: string[]
    todos: string[]
    moreTodos: number
    facts: Fact[]
  }, config?: { maxContextChars: number }): string | undefined
}
declare module '@deepseek-ai/cordis' {
  interface Context { liangshenState: StateReader }
}

// Local declarations describe the shipped JavaScript modules at this test boundary.
const statePlugin = await import(new URL('../presets/liangshen/state.mjs', import.meta.url).href) as StateModule
const ledger = await import(new URL('../presets/liangshen/fact-ledger.mjs', import.meta.url).href) as LedgerModule
const working = await import(new URL('../presets/liangshen/working-context.mjs', import.meta.url).href) as WorkingModule

async function setup(stateConfig = {}, workingConfig = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjections)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeExecutor)
  await ctx.plugin(statePlugin, stateConfig)
  const state = ctx.get('liangshenState')
  if (state === undefined) throw new Error('Deep state did not activate')
  const ledgerFiber = ctx.plugin(ledger)
  await ledgerFiber
  await ctx.plugin(working, workingConfig)
  const session = ctx.sessions.create(SessionId('deep-state-test'))
  const agent = { id: session.id, session, ctx } as Agent
  let ordinal = 0
  const native = (args: object, failed = false) => {
    const callId = ToolCallId(`fact-${++ordinal}`)
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'fact_register', arguments: JSON.stringify(args) })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({ callId, isError: failed, content: [{ type: 'text', text: failed ? 'failed' : 'recorded' }] }),
    }, { surfaceOp: 'append' })
  }
  const inject = async (commit = true) => {
    const decision = await ctx.waterfall('agent/pre-step', {
      agent, messages: [], turn: 1, step: 1, signal: new AbortController().signal,
      modelSelection: { provider: 'test', model: 'test' },
    }, (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [], startsRequestSeries: true }))
    if (decision.kind !== 'enter') throw new Error('unexpected rejected admission')
    if (commit && decision.messages.length > 0) {
      session.append('step/start', { turn: 1, step: state.context(session).stepCount + 1 })
      for (const message of decision.messages) session.append('user/message', message, { surfaceOp: 'append' })
    }
    return decision
  }
  return { ctx, state, session, native, inject, ledgerFiber }
}

it('replays native successes, ignores failed facts, and revokes by tag', async () => {
  const h = await setup()
  h.native({ fact: 'Use TypeScript', tag: 'language' })
  h.native({ fact: 'Do not retain this' }, true)
  expect(h.state.facts(h.session)).toEqual([{ text: 'Use TypeScript', tag: 'language' }])
  h.native({ revoke: 'language' })
  expect(h.state.facts(h.session)).toEqual([])
})

it.each([false, true])('reads settled PTC fact operations without native child events (failed=%s)', async (failed) => {
  const h = await setup()
  const root = ToolCallId('program')
  const data = { rootCallId: root, parentCallId: root, subCallId: ToolCallId('program:ptc:1'), name: 'fact_register', arguments: { fact: 'PTC fact' } }
  h.session.append('tool/call', { turn: 1, step: 1, callId: root, name: 'run_code', arguments: '{}' })
  h.session.append('tool/ptc-dispatch-start', data)
  expect(h.state.facts(h.session)).toEqual([])
  h.session.append('tool/ptc-dispatch', { ...data, isError: failed, content: [] })
  expect(h.state.facts(h.session)).toEqual(failed ? [] : [{ text: 'PTC fact' }])
})

it('settles facts in result order and retains pending calls through checkpoint recovery', async () => {
  const h = await setup()
  const callId = ToolCallId('pending')
  h.session.append('tool/call', { turn: 1, step: 1, callId, name: 'fact_register', arguments: JSON.stringify({ fact: 'Recovered fact' }) })
  const checkpoint = h.ctx.sessionProjections.checkpoint(h.session)
  h.session.append('tool/result', {
    turn: 1, step: 1, message: createToolResultMessage({ callId, isError: false, content: [] }),
  }, { surfaceOp: 'append' })
  const other = await setup()
  const revived = Session.create(h.session.id, h.session.snapshotEvents(), h.session.header)
  const floor = other.ctx.sessionProjections.restoreFloor(checkpoint)!
  other.ctx.sessionProjections.hydrate(revived, checkpoint, h.session.snapshotEvents(floor), floor)
  expect(other.state.facts(revived)).toEqual(h.state.facts(h.session))
  expect(other.state.facts(revived)).toEqual([{ text: 'Recovered fact' }])
})

it('bounds legacy tags and the complete rendered ledger by evicting whole oldest facts', async () => {
  const h = await setup({ maxFacts: 3, maxFactChars: 16, maxTagChars: 8, maxLedgerChars: 48 })
  h.native({ fact: 'first fact', tag: 'x'.repeat(20_000) })
  h.native({ fact: 'second fact', tag: 'second' })
  h.native({ fact: 'third fact', tag: 'third' })
  const facts = h.state.facts(h.session)
  expect(facts.every(item => (item.tag?.length ?? 0) <= 8)).toBe(true)
  expect(ledger.renderLedgerField(facts)?.length).toBeLessThanOrEqual(48)
  expect(facts.at(-1)?.text).toBe('third fact')
})

it.each([
  { fact: 'ok', tag: 'x'.repeat(49) },
  { fact: 'a\nb' },
  { fact: 'x'.repeat(161) },
  { fact: ' ' },
  { fact: 'ok', tag: 'a\nb' },
])('rejects invalid new fact inputs through the executor: %j', async (args) => {
  const h = await setup()
  const result = await h.ctx.tools.execute({
    calls: [{ id: ToolCallId('invalid-fact'), type: 'tool-call', name: 'fact_register', arguments: JSON.stringify(args) }],
    signal: new AbortController().signal,
  })
  expect(result.results[0]?.result.isError).toBe(true)
  expect(h.state.facts(h.session)).toEqual([])
})

it('bounds the complete context text and explicitly clears revoked facts', async () => {
  const h = await setup({}, { maxContextChars: 128 })
  h.native({ fact: 'A short fact', tag: 'constraint' })
  const first = await h.inject()
  expect(first.startsRequestSeries).toBe(true)
  expect(first.messages).toHaveLength(1)
  const text = first.messages[0]?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(text).toMatchInlineSnapshot(`
    "[Working Context: key facts: A short fact [constraint] | supersedes earlier working context]"
  `)
  h.native({ revoke: 'constraint' })
  const cleared = await h.inject()
  expect(JSON.stringify(cleared.messages[0]?.content)).toContain('earlier working context no longer applies')
  expect((await h.inject()).messages).toEqual([])
})

it('refreshes unchanged facts after the configured number of admitted steps', async () => {
  const h = await setup({}, { refreshAfterSteps: 2 })
  h.native({ fact: 'Keep project files' })
  await h.inject()
  expect((await h.inject(false)).messages).toEqual([])
  h.session.append('step/start', { turn: 1, step: 2 })
  expect((await h.inject(false)).messages).toHaveLength(1)
})

it('republishes context after its visible node is replaced, without scanning historical messages', async () => {
  const h = await setup()
  h.native({ fact: 'Visible again' })
  await h.inject()
  const last = SessionSeq(h.session.seq - 1)
  h.session.append('user/message', {
    id: MessageId('compacted'), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Compacted earlier context' }],
  }, { surfaceOp: { op: 'replace', startSeq: last, endSeq: last }, sourceEventSeqs: [last] })
  expect(h.state.published(h.session, 'context')?.visible).toBe(false)
  expect((await h.inject(false)).messages).toHaveLength(1)
})

it('reads unchanged state without rescanning the full Session log on every access', async () => {
  const h = await setup()
  h.native({ fact: 'One fact in a long session' })
  for (let index = 0; index < 10_000; index += 1) h.session.append('step/end', { turn: 1, step: index })
  h.state.facts(h.session)
  const scan = vi.spyOn(h.session, 'snapshotEvents')
  for (let index = 0; index < 1_000; index += 1) {
    h.state.facts(h.session)
    h.state.paging(h.session)
    h.state.context(h.session)
  }
  expect(scan).not.toHaveBeenCalled()
})

it('rejects inconsistent budgets at plugin activation and unregisters the fact tool on unload', async () => {
  const h = await setup()
  await h.ledgerFiber.dispose()
  expect(h.ctx.tools.schemas().map(tool => tool.name)).not.toContain('fact_register')
  await expect(statePlugin.apply(h.ctx, { maxLedgerChars: 32 })).rejects.toThrow('maxLedgerChars must fit')
})

it('bounds the complete text even when namespace names are huge or multibyte', () => {
  const rendered = working.renderWorkingContext({
    plan: { seen: true, active: false }, active: ['界'.repeat(20_000)],
    todos: ['task'], moreTodos: 0, facts: [{ text: 'A complete fact', tag: 'topic' }],
  }, { maxContextChars: 128 })
  expect(rendered).toBeDefined()
  expect(Array.from(rendered ?? '').length).toBeLessThanOrEqual(128)
  expect(rendered).toContain('[truncated; supersedes earlier context]')
})

it('shares the same projection key when equivalent config fields are reordered', () => {
  const config = statePlugin.Config({})
  const reversed = Object.fromEntries(Object.entries(config).reverse())
  expect(statePlugin.createDeepStateDefinition(reversed).key).toBe(statePlugin.createDeepStateDefinition(config).key)
})

it('preserves historical long-tag revocation identity after bounded rendering', async () => {
  const h = await setup()
  const tag = 'legacy-'.repeat(100)
  h.native({ fact: 'Old fact', tag })
  expect(h.state.facts(h.session)[0]?.tag?.length).toBeLessThanOrEqual(48)
  h.native({ revoke: tag })
  expect(h.state.facts(h.session)).toEqual([])
})
