/** Liangshen paging and catalogs use the same scoped, step-admitted tool set. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { createScope, scopeTarget, type Scope } from '@deepseek-ai/dsh-scope'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { expect, it, onTestFinished } from 'vitest'

// These vendored JavaScript modules intentionally have no TypeScript entrypoint.
const catalog = await import(new URL('../presets/liangshen/tool-catalog.mjs', import.meta.url).href)
const paging = await import(new URL('../presets/liangshen/paging.mjs', import.meta.url).href)
const signal = new AbortController().signal
const selection = { provider: 'test', model: 'test' }

/** Mount actual registries and executor; no program is evaluated by these schema tests. */
async function setup(mode: 'native' | 'ptc' = 'native') {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  if (mode === 'ptc') {
    // Only schema/SDK rendering reads this deterministic runtime descriptor.
    ctx.provide('ptcRuntime', { language: 'typescript', programFormat: 'function-body' } as never)
    await ctx.plugin(PtcExecutor)
  } else await ctx.plugin(NativeExecutor)
  const register = (name: string, enabled?: () => boolean) => ctx.tools.register(defineTool({
    name, description: `Inspect ${name}.`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'done',
  }), enabled === undefined ? {} : { when: enabled })
  register('read')
  register('mcp__alpha__inspect')
  register('mcp__beta__inspect')
  let conditional = false
  register('conditional', () => conditional)
  const fiber = ctx.plugin(catalog, { maxActiveNamespaces: 1 })
  await fiber
  const agent = { id: SessionId('catalog-agent'), session: Session.create(SessionId('catalog-agent')) } as Agent
  let scope!: Scope
  await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
  Object.assign(agent, { ctx: scope.ctx })
  await ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
  const assemble = async () => {
    const toolSet = await ctx.tools.resolve({ agent, modelSelection: selection, signal })
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, toolSet })
    return { toolSet, assembly }
  }
  const inject = () => ctx.waterfall(scopeTarget(agent, agent), 'agent/pre-step', {
    agent, messages: [], turn: 1, step: 1, signal, modelSelection: selection,
  }, (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] }))
  const text = async () => {
    const decision = await inject()
    if (decision.kind !== 'enter') throw new Error('unexpected rejected step')
    return decision.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
  }
  let activation = 0
  const activate = (namespace: string, failed = false) => {
    const callId = ToolCallId(`activate-${namespace}-${++activation}`)
    agent.session.append('tool/call', { turn: 1, step: 1, callId, name: 'tool_activate', arguments: JSON.stringify({ namespace }) })
    agent.session.append('tool/result', {
      turn: 1, step: 1, message: createToolResultMessage({ callId, isError: failed, content: [{ type: 'text', text: failed ? 'failed' : 'done' }] }),
    }, { surfaceOp: 'append' })
    // Real Session publication emits this synchronously after the full tool batch settles.
    ctx.emit('session/event', agent.session, agent.session.append('step/end', { turn: 1, step: 1 }))
  }
  return { ctx, fiber, agent, register, assemble, inject, text, activate, enable: () => { conditional = true } }
}

it.each(['native', 'ptc'] as const)('pages the first %s request before SDK rendering and preserves conditional admission', async (mode) => {
  const h = await setup(mode)
  const { assembly, toolSet } = await h.assemble()
  onTestFinished(() => toolSet.dispose())
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent, toolSet)).toBeUndefined()
  expect(h.ctx.tools.schemas(h.agent, toolSet).map(tool => tool.name)).toEqual(['read'])
  const text = await h.text()
  expect(text).toContain('`read(')
  expect(text).toContain('`alpha` (1 tool')
  expect(text).not.toContain('`conditional(')
  if (mode === 'ptc') {
    expect(assembly.tools.map(tool => tool.name)).toEqual(['run_code'])
    const sdk = assembly.sections.find(section => section.name === 'tools:sdk')?.text ?? ''
    expect(sdk).toContain('read')
    expect(sdk).not.toContain('mcp__alpha__inspect')
    expect(sdk).not.toContain('conditional')
    expect(text).toContain('Only `run_code` is directly callable')
  } else expect(assembly.tools.map(tool => tool.name)).toEqual(['read'])
  h.enable()
  const next = await h.assemble()
  onTestFinished(() => next.toolSet.dispose())
  expect(await h.text()).toContain('`conditional(')
})

it('activates on the next admission, ignores failed activation, and evicts least-recently used namespaces', async () => {
  const h = await setup('ptc')
  const first = await h.assemble()
  h.activate('alpha')
  expect(h.ctx.tools.schemas(h.agent, first.toolSet).map(tool => tool.name)).toEqual(['read'])
  first.toolSet.dispose()
  const second = await h.assemble()
  expect(h.ctx.tools.schemas(h.agent, second.toolSet).map(tool => tool.name)).toContain('mcp__alpha__inspect')
  expect(second.assembly.sections.find(section => section.name === 'tools:sdk')?.text).toContain('mcp__alpha__inspect')
  expect(await h.text()).toContain('namespace `alpha` (activated)')
  second.toolSet.dispose()
  h.activate('beta', true)
  const failed = await h.assemble()
  expect(h.ctx.tools.schemas(h.agent, failed.toolSet).map(tool => tool.name)).toContain('mcp__alpha__inspect')
  failed.toolSet.dispose()
  h.activate('beta')
  const third = await h.assemble()
  expect(h.ctx.tools.schemas(h.agent, third.toolSet).map(tool => tool.name)).toEqual(['read', 'mcp__beta__inspect'])
  third.toolSet.dispose()
})

it('retains one visible catalog, republishes changed admission, and lifts restrictions on unload', async () => {
  const h = await setup()
  const first = await h.assemble()
  first.toolSet.dispose()
  const admitted = await h.inject()
  if (admitted.kind !== 'enter') throw new Error('unexpected rejected step')
  for (const message of admitted.messages) h.agent.session.append('user/message', message, { surfaceOp: 'append' })
  expect(await h.text()).toBe('')
  h.enable()
  const second = await h.assemble()
  second.toolSet.dispose()
  expect(await h.text()).toContain('`conditional(')
  expect(h.ctx.tools.schemas().map(tool => tool.name)).toContain('mcp__alpha__inspect')
  await h.fiber.dispose()
  expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toContain('mcp__alpha__inspect')
})

it('refreshes paging for tools registered between turns before their step admission', async () => {
  const h = await setup()
  h.register('mcp__gamma__inspect')
  h.ctx.emit(scopeTarget(h.agent, h.agent), 'agent/inbox/claimed', {
    agent: h.agent, turn: 1, message: createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] }),
  })
  const next = await h.assemble()
  expect(h.ctx.tools.schemas(h.agent, next.toolSet).map(tool => tool.name)).not.toContain('mcp__gamma__inspect')
  expect(await h.text()).toContain('`gamma` (1 tool')
  next.toolSet.dispose()
})

/** Append current-format call/result events to a detached replay Session. */
function replayFixture() {
  const session = Session.create(SessionId('paging-replay'))
  let ordinal = 0
  const call = (name: string, args: Record<string, string> = {}) => {
    const callId = ToolCallId(`paging-${++ordinal}`)
    session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
    return callId
  }
  const settle = (callId: ReturnType<typeof ToolCallId>, isError = false) => session.append('tool/result', {
    turn: 1, step: 1, message: createToolResultMessage({ callId, isError, content: [{ type: 'text', text: isError ? 'failed' : 'done' }] }),
  }, { surfaceOp: 'append' })
  const activate = (namespace: string) => { const callId = call('tool_activate', { namespace }); settle(callId) }
  return { session, call, settle, activate, replay: (capacity = 2) => paging.replayActivations(session.snapshotEvents(), capacity) }
}

it('replays only matched successful settlements, retaining pending activations across a snapshot', () => {
  const h = replayFixture()
  const pending = h.call('tool_activate', { namespace: 'alpha' })
  const failed = h.call('tool_activate', { namespace: 'beta' })
  h.settle(failed, true)
  h.settle(ToolCallId('no-preceding-call'))
  const interrupted = h.session.snapshotEvents()
  expect(paging.replayActivations(interrupted)).toEqual({ active: [], evicted: [] })
  h.settle(pending)
  expect(h.replay()).toEqual({ active: ['alpha'], evicted: [] })
  // Replaying the earlier immutable snapshot cannot inherit later process state.
  expect(paging.replayActivations(interrupted)).toEqual({ active: [], evicted: [] })
})

it('defines namespace recency by successful settlement order rather than invocation order', () => {
  const h = replayFixture()
  const first = h.call('tool_activate', { namespace: 'alpha' })
  const second = h.call('tool_activate', { namespace: 'beta' })
  h.settle(second)
  h.settle(first)
  expect(h.replay(1)).toEqual({ active: ['alpha'], evicted: ['beta'] })
})

it.each(['pending', 'failed', 'successful'] as const)('refreshes an active namespace only after a successful call: %s', (status) => {
  const h = replayFixture()
  h.activate('alpha')
  h.activate('beta')
  const use = h.call('mcp__alpha__inspect')
  if (status !== 'pending') h.settle(use, status === 'failed')
  h.activate('gamma')
  expect(h.replay()).toEqual(status === 'successful'
    ? { active: ['alpha', 'gamma'], evicted: ['beta'] }
    : { active: ['beta', 'gamma'], evicted: ['alpha'] })
})
