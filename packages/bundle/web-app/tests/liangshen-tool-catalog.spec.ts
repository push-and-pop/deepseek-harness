/** Paging uses projected settlements, live registry masks and the admitted native/PTC surface. */
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createAssistantMessage, createUserMessage, createToolResultMessage, ToolCallId, type ToolSchema } from '@deepseek-ai/dsh-llm'
import { PtcRuntime, type PtcJsonValue, type PtcRunRequest, type PtcRunResult, type PtcRunSpec } from '@deepseek-ai/dsh-ptc-runtime'
import { createScope, scopeTarget, type Scope } from '@deepseek-ai/dsh-scope'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool, type ResolvedToolSet } from '@deepseek-ai/dsh-tools'
import * as NativeExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as PtcExecutor from '@deepseek-ai/dsh-tool-executor-ptc'
import { expect, it, onTestFinished, vi } from 'vitest'

interface PresetPlugin {
  name: string
  inject: string[]
  apply(ctx: Context, config?: Record<string, unknown>): void | Promise<void>
}
interface SurfaceMeasurement {
  schemaCount: number
  characters: number
  bytes: number
  estimatedTokens: number
}
interface PagingOptions { patterns: readonly string[]; capacity: number }
interface PagingModule {
  replayActivations(events: readonly SessionEvent[], capacity?: number): { active: readonly string[]; evicted: readonly string[] }
  applyPaging(
    active: readonly string[], call: { name: string; arguments: Record<string, string> }, options: PagingOptions,
  ): readonly string[]
}

// The JavaScript plugins have no TS entrypoint; assertions describe the imported test collaborators.
const catalog = await import(new URL('../presets/liangshen/tool-catalog.mjs', import.meta.url).href) as PresetPlugin & {
  measureSurface(schemas: object[]): SurfaceMeasurement
  estimateSurfaceTokens(schemas: ToolSchema[]): number
}
const paging = await import(new URL('../presets/liangshen/paging.mjs', import.meta.url).href) as PagingModule
const state = await import(new URL('../presets/liangshen/state.mjs', import.meta.url).href) as PresetPlugin
const activation = await import(new URL('../presets/liangshen/tool-activate.mjs', import.meta.url).href) as PresetPlugin
const signal = new AbortController().signal
const selection = { provider: 'test', model: 'test' }

/** Evaluate only test-authored JavaScript against the actual executor's SDK bindings. */
class TestRuntime extends PtcRuntime {
  readonly language = 'typescript'
  readonly isolation = 'test-vm'
  resolve(request: PtcRunRequest): PtcRunSpec {
    return { ...request, cwd: request.cwd ?? process.cwd(), timeoutMs: null }
  }
  async run(request: PtcRunSpec): Promise<PtcRunResult> {
    try {
      // node:vm returns an untyped result; these trusted fixtures return canonical binding values.
      const value = await (runInNewContext(`(async () => { ${request.program}\n})()`, {
        tools: request.bindings.find(binding => binding.global === 'tools')!.functions,
      }) as Promise<PtcJsonValue>)
      return { logs: [], ...value === undefined ? {} : { value } }
    } catch (error) {
      return { logs: [], error: { kind: 'exception', message: String(error) } }
    }
  }
}

interface SetupOptions {
  capacity?: number
  seed?: SessionEvent[]
  descriptionSize?: number
  budgetMode?: 'warn' | 'enforce'
  budget?: number | ((schemas: ToolSchema[]) => number)
}

/** Mount real Session/store/projection lifecycles and both production executor paths. */
async function setup(mode: 'native' | 'ptc' = 'native', options: SetupOptions = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(state, { maxActiveNamespaces: options.capacity ?? 1 })
  if (mode === 'ptc') {
    await ctx.plugin(TestRuntime)
    await ctx.plugin(PtcExecutor)
  } else await ctx.plugin(NativeExecutor)
  const register = (name: string, enabled?: () => boolean, fail = false) => ctx.tools.register(defineTool({
    name, description: `Inspect ${name}.${'x'.repeat(options.descriptionSize ?? 0)}`, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => { if (fail) throw new Error('inspection failed'); return 'done' },
  }), enabled === undefined ? {} : { when: enabled })
  register('read')
  register('mcp__alpha__inspect')
  register('mcp__beta__inspect')
  let conditional = false
  register('conditional', () => conditional)
  await ctx.plugin(activation)
  const budget = typeof options.budget === 'function' ? options.budget(ctx.tools.schemas()) : options.budget
  const catalogConfig = {
    ...budget === undefined ? {} : { maxResidentTokens: budget },
    ...options.budgetMode === undefined ? {} : { budgetMode: options.budgetMode },
  }
  let fiber = ctx.plugin(catalog, catalogConfig)
  await fiber
  let ordinal = 0
  const mint = async (seed?: SessionEvent[]) => {
    const id = SessionId(`catalog-agent-${++ordinal}`)
    const session = ctx.sessions.create(id, seed === undefined ? undefined : { seed })
    const agent = { id, session } as Agent
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => { scope = createScope(inner, agent) }, { inject: ['tools', 'systemPrompt'] }))
    Object.assign(agent, { ctx: scope.ctx })
    await ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
    return agent
  }
  const agent = await mint(options.seed)
  const assemble = async (owner = agent) => {
    const toolSet = await ctx.tools.resolve({ agent: owner, modelSelection: selection, signal })
    onTestFinished(() => { toolSet.dispose() })
    const assembly = await ctx.systemPrompt.assemble({ scope: owner, toolSet })
    return { toolSet, assembly }
  }
  const inject = (owner = agent) => ctx.waterfall(scopeTarget(owner, owner), 'agent/pre-step', {
    agent: owner, messages: [], turn: 1, step: 1, signal, modelSelection: selection,
  }, (): Promise<PreStepDecision> => Promise.resolve({ kind: 'enter', messages: [] }))
  const text = async (owner = agent) => {
    const decision = await inject(owner)
    if (decision.kind !== 'enter') throw new Error('unexpected rejected step')
    return decision.messages.flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
  }
  let callOrdinal = 0
  const execute = async (name: string, args: Record<string, string> = {}, owner = agent, admitted?: ResolvedToolSet) => {
    const toolSet = admitted ?? (await assemble(owner)).toolSet
    owner.session.append('step/start', { turn: 1, step: callOrdinal + 1 })
    const batch = await ctx.tools.execute({
      calls: [{
        type: 'tool-call', id: ToolCallId(`call-${++callOrdinal}`), name: mode === 'ptc' ? 'run_code' : name,
        arguments: JSON.stringify(mode === 'ptc'
          ? { code: `return await tools[${JSON.stringify(name)}](${JSON.stringify(args)})`, description: 'Exercise the actual generated SDK binding' }
          : args),
      }], agent: owner, toolSet, signal, log: { turn: 1, step: callOrdinal },
    })
    owner.session.append('step/end', { turn: 1, step: callOrdinal })
    return batch.results[0]!.result
  }
  return {
    ctx, agent, register, mint, assemble, inject, text, execute,
    activate: (namespace: string, owner = agent) => execute('tool_activate', { namespace }, owner),
    enable: () => { conditional = true },
    disposeCatalog: () => fiber.dispose(),
    remountCatalog: async () => { fiber = ctx.plugin(catalog, catalogConfig); await fiber },
  }
}

it.each(['native', 'ptc'] as const)('pages the first %s request before SDK rendering and preserves conditional admission', async (mode) => {
  const h = await setup(mode)
  const { assembly, toolSet } = await h.assemble()
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent, toolSet)).toBeUndefined()
  expect(h.ctx.tools.schemas(h.agent, toolSet).map(tool => tool.name)).toEqual(['read', 'tool_activate'])
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
  } else expect(assembly.tools.map(tool => tool.name)).toEqual(['read', 'tool_activate'])
  h.enable()
  await h.assemble()
  expect(await h.text()).toContain('`conditional(')
})

it.each(['native', 'ptc'] as const)('activates through the real %s executor only for the next admission and rejects failures', async (mode) => {
  const h = await setup(mode)
  const first = await h.assemble()
  expect((await h.execute('tool_activate', { namespace: 'alpha' }, h.agent, first.toolSet)).isError).toBe(false)
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent, first.toolSet)).toBeUndefined()
  const second = await h.assemble()
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent, second.toolSet)).toBeDefined()
  expect(await h.text()).toContain('namespace `alpha` (activated)')
  expect((await h.activate('missing')).isError).toBe(true)
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent, (await h.assemble()).toolSet)).toBeDefined()
  expect((await h.activate('beta')).isError).toBe(false)
  const third = await h.assemble()
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent, third.toolSet)).toBeUndefined()
  expect(h.ctx.tools.get('mcp__beta__inspect', h.agent, third.toolSet)).toBeDefined()
  if (mode === 'ptc') {
    const events = h.agent.session.snapshotEvents()
    expect(events.some(event => event.type === 'tool/call' && event.data.name === 'tool_activate')).toBe(false)
    expect(events.some(event => event.type === 'tool/ptc-dispatch' && event.data.name === 'tool_activate' && !event.data.isError)).toBe(true)
  }
})

it.each(['native', 'ptc'] as const)('uses successful %s settlements for LRU, supports refresh, and restores without runtime effects', async (mode) => {
  const h = await setup(mode, { capacity: 2 })
  h.register('mcp__gamma__inspect')
  h.register('mcp__alpha__fail', undefined, true)
  await h.activate('alpha')
  await h.activate('beta')
  expect((await h.execute('mcp__alpha__fail')).isError).toBe(true)
  await h.activate('gamma')
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent)).toBeUndefined()
  await h.activate('alpha')
  expect((await h.execute('mcp__gamma__inspect')).isError).toBe(false)
  expect((await h.activate('alpha')).isError).toBe(false)
  await h.activate('beta')
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent)).toBeDefined()
  expect(h.ctx.tools.get('mcp__gamma__inspect', h.agent)).toBeUndefined()
  const restored = await setup(mode, { capacity: 2, seed: [...h.agent.session.snapshotEvents()] })
  expect(restored.ctx.tools.get('mcp__alpha__inspect', restored.agent)).toBeDefined()
  expect(restored.ctx.tools.get('mcp__beta__inspect', restored.agent)).toBeDefined()
  expect(restored.agent.session.snapshotEvents().filter(event => event.type.startsWith('tool/')))
    .toEqual(h.agent.session.snapshotEvents().filter(event => event.type.startsWith('tool/')))
})

it('pins a fact through the actual PTC SDK and projected state owner', async () => {
  const h = await setup('ptc')
  const ledger = await import(new URL('../presets/liangshen/fact-ledger.mjs', import.meta.url).href) as PresetPlugin
  await h.ctx.plugin(ledger)
  expect((await h.execute('fact_register', { fact: 'Review stays read-only', tag: 'constraint' })).isError).toBe(false)
  const projected = h.ctx.get('liangshenState') as { facts(session: Session): { text: string; tag?: string }[] }
  expect(projected.facts(h.agent.session)).toEqual([{ text: 'Review stays read-only', tag: 'constraint' }])
  expect(h.agent.session.snapshotEvents().some(event => event.type === 'tool/call' && event.data.name === 'fact_register')).toBe(false)
})

it('keeps Agent activation independent and never rescans Session history for live operations', async () => {
  const h = await setup('ptc')
  const other = await h.mint()
  vi.spyOn(h.agent.session, 'snapshotEvents').mockImplementation(() => { throw new Error('unexpected history scan') })
  vi.spyOn(h.agent.session, 'deriveMessages').mockImplementation(() => { throw new Error('unexpected history scan') })
  expect((await h.activate('alpha')).isError).toBe(false)
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent)).toBeDefined()
  expect(h.ctx.tools.get('mcp__alpha__inspect', other)).toBeUndefined()
  await h.assemble()
  expect(await h.text()).toContain('namespace `alpha` (activated)')
})

it('isolates canonical paging options across two preset scopes sharing the Host registries', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(NativeExecutor)
  for (const name of ['mcp__alpha__inspect', 'mcp__beta__inspect']) {
    ctx.tools.register(defineTool({
      name, description: name, parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => 'done',
    }))
  }
  let nextId = 0
  const preset = async (capacity: number) => {
    const key = {}
    let agent!: Agent
    await ctx.plugin(Object.assign(async (inner: Context) => {
      const outer = createScope(inner, key)
      const isolated = outer.ctx.isolate('liangshenState')
      await isolated.plugin(state, { maxActiveNamespaces: capacity })
      await isolated.plugin(activation)
      await isolated.plugin(catalog)
      const id = SessionId(`isolated-${++nextId}`)
      agent = { id } as Agent
      const scope = createScope(isolated, agent, { parent: key })
      Object.assign(agent, { ctx: scope.ctx, session: scope.ctx.sessions.create(id) })
      await ctx.serial(scopeTarget(agent, agent), 'agent/created', { agent, source: 'startup' })
    }, { inject: ['tools', 'systemPrompt', 'sessions'] }))
    return agent
  }
  const first = await preset(1)
  const second = await preset(2)
  let ordinal = 0
  for (const agent of [first, second]) {
    for (const namespace of ['alpha', 'beta']) {
      const toolSet = await ctx.tools.resolve({ agent, modelSelection: selection, signal })
      const result = await ctx.tools.execute({
        calls: [{ type: 'tool-call', id: ToolCallId(`scope-${++ordinal}`), name: 'tool_activate', arguments: JSON.stringify({ namespace }) }],
        agent, toolSet, signal, log: { turn: 1, step: ordinal },
      })
      toolSet.dispose()
      agent.session.append('step/end', { turn: 1, step: ordinal })
      expect(result.results[0]!.result.isError).toBe(false)
    }
  }
  expect(ctx.tools.get('mcp__alpha__inspect', first)).toBeUndefined()
  expect(ctx.tools.get('mcp__alpha__inspect', second)).toBeDefined()
  expect(ctx.tools.get('mcp__beta__inspect', first)).toBeDefined()
  expect(ctx.tools.get('mcp__beta__inspect', second)).toBeDefined()
})

it.each(['native', 'ptc'] as const)('immediately pages late %s registrations and replacements without an inbox event', async (mode) => {
  const h = await setup(mode)
  const remove = h.register('mcp__gamma__inspect')
  const late = await h.assemble()
  expect(h.ctx.tools.get('mcp__gamma__inspect', h.agent, late.toolSet)).toBeUndefined()
  expect(await h.text()).toContain('`gamma` (1 tool')
  remove()
  expect(await h.text()).toContain('`gamma`') // No new assembly has occurred yet.
  h.register('mcp__gamma__replacement')
  const replacement = await h.assemble()
  expect(h.ctx.tools.get('mcp__gamma__replacement', h.agent, replacement.toolSet)).toBeUndefined()
  expect(await h.text()).toContain('mcp__gamma__replacement')
})

it('keeps other restrictions throughout paging updates and releases only its own masks on unload', async () => {
  const h = await setup()
  const stopPolicy = h.agent.ctx.tools.restrict({ deny: ['mcp__alpha__inspect'] })
  const visibleDuringChanges: string[][] = []
  const stopObserve = h.ctx.on('tools/change', () => {
    visibleDuringChanges.push(h.ctx.tools.schemas(h.agent).map(tool => tool.name))
  })
  await h.activate('beta')
  h.register('mcp__gamma__inspect')
  expect(visibleDuringChanges.every(names => !names.includes('mcp__alpha__inspect') && !names.includes('mcp__gamma__inspect'))).toBe(true)
  expect(h.ctx.tools.get('mcp__gamma__inspect', h.agent)).toBeUndefined()
  stopObserve()
  await h.disposeCatalog()
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent)).toBeUndefined()
  expect(h.ctx.tools.get('mcp__gamma__inspect', h.agent)).toBeDefined()
  stopPolicy()
})

it('reapplies paging on the first assembly after catalog hot reload', async () => {
  const h = await setup('ptc')
  await h.activate('alpha')
  await h.disposeCatalog()
  expect(h.ctx.tools.get('mcp__beta__inspect', h.agent)).toBeDefined()
  await h.remountCatalog()
  const next = await h.assemble()
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent, next.toolSet)).toBeDefined()
  expect(h.ctx.tools.get('mcp__beta__inspect', h.agent, next.toolSet)).toBeUndefined()
})

it('blocks preparation for unpageable Agent-local registrations and recovers after removal', async () => {
  const h = await setup()
  const stop = h.agent.ctx.tools.register(defineTool({
    name: 'mcp__local__inspect', description: 'Agent-local fixture', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: async () => 'done',
  }))
  await expect(h.assemble()).rejects.toMatchObject({ code: 'LIANGSHEN_PAGING_FAILED' })
  expect(h.ctx.tools.get('mcp__beta__inspect', h.agent)).toBeUndefined()
  stop()
  await expect(h.assemble()).resolves.toBeDefined()
})

it('deduplicates durable catalogs and republishes after the visible node is compacted away', async () => {
  const h = await setup()
  await h.assemble()
  const admitted = await h.inject()
  if (admitted.kind !== 'enter') throw new Error('unexpected rejected step')
  const catalogMessage = admitted.messages.find(message => message.source.kind === catalog.name)!
  const published = h.agent.session.append('user/message', catalogMessage, { surfaceOp: 'append' })
  expect(await h.text()).toBe('')
  h.agent.session.append('user/message', createUserMessage({
    source: { kind: 'user' }, content: [{ type: 'text', text: 'compacted' }],
  }), { surfaceOp: { op: 'replace', startSeq: published.seq, endSeq: published.seq }, sourceEventSeqs: [published.seq] })
  expect(await h.text()).toContain('<available_tools>')
})

it('measures the complete serialized schema array and labels multibyte bytes separately', () => {
  const schemas = [{ name: 'read', description: '中文', parameters: {} }]
  const serialized = JSON.stringify(schemas)
  expect(catalog.measureSurface(schemas)).toEqual({
    schemaCount: 1, characters: serialized.length, bytes: Buffer.byteLength(serialized),
    estimatedTokens: Math.ceil(serialized.length / 4),
  })
})

it('reports durable provider usage for owned requests without estimating or reading history', async () => {
  const h = await setup()
  const debug = vi.spyOn(h.ctx.logger, 'debug')
  vi.spyOn(h.agent.session, 'snapshotEvents').mockImplementation(() => { throw new Error('unexpected history scan') })
  vi.spyOn(h.agent.session, 'deriveMessages').mockImplementation(() => { throw new Error('unexpected history scan') })
  const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 150, cacheReadTokens: 30, cacheWriteTokens: 0, reasoningTokens: 10 }
  h.agent.session.append('assistant/message', {
    turn: 1, step: 1, stream: [], usage,
    message: createAssistantMessage({ content: [{ type: 'text', text: 'done' }], source: { provider: 'test-provider', model: 'test-model' } }),
  }, { surfaceOp: 'append' })
  expect(debug.mock.calls).toEqual([[`${catalog.name}: ${JSON.stringify({
    kind: 'provider-reported-request-usage', ...usage, provider: 'test-provider', model: 'test-model',
  })}`]])
})

it('does not invent absent usage or report usage from sessions outside the preset', async () => {
  const h = await setup()
  const debug = vi.spyOn(h.ctx.logger, 'debug')
  const foreign = h.ctx.sessions.create(SessionId('other-preset-session'))
  const message = createAssistantMessage({ content: [], source: { provider: 'test-provider', model: 'test-model' } })
  h.agent.session.append('assistant/message', { turn: 1, step: 1, stream: [], message }, { surfaceOp: 'append' })
  foreign.append('assistant/message', {
    turn: 1, step: 1, stream: [], message, usage: { inputTokens: 0, outputTokens: 0 },
  }, { surfaceOp: 'append' })
  expect(debug).not.toHaveBeenCalled()
})

it('warns without withholding admitted tools by default and reports the measured scope', async () => {
  const h = await setup('ptc', { budget: 1 })
  const warning = vi.spyOn(h.ctx.logger, 'warn')
  await h.activate('alpha')
  const admitted = await h.assemble()
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent, admitted.toolSet)).toBeDefined()
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('"kind":"serialized-capability-schemas"'))
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('"budgetMode":"warn"'))
  expect(warning).toHaveBeenCalledWith(expect.stringContaining('generated SDK'))
})

it.each(['native', 'ptc'] as const)('enforces the %s estimate with whole-namespace LRU deferral and supports retry', async (mode) => {
  const h = await setup(mode, {
    capacity: 3, descriptionSize: 1000, budgetMode: 'enforce',
    budget: schemas => catalog.estimateSurfaceTokens(schemas.filter(tool => tool.name !== 'conditional' && (!tool.name.startsWith('mcp__') || tool.name.startsWith('mcp__alpha__')))),
  })
  await h.activate('alpha')
  await h.activate('beta')
  const admitted = await h.assemble()
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent, admitted.toolSet)).toBeUndefined()
  expect(h.ctx.tools.get('mcp__beta__inspect', h.agent, admitted.toolSet)).toBeDefined()
  const residentNames = h.ctx.tools.schemas(h.agent, admitted.toolSet).filter(tool => !tool.name.startsWith('mcp__')).map(tool => tool.name)
  expect(residentNames).toEqual(['read', 'tool_activate'])
  // Re-activating a requested-but-budget-deferred namespace must refresh its LRU.
  expect((await h.activate('alpha')).isError).toBe(false)
  const retried = await h.assemble()
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent, retried.toolSet)).toBeDefined()
  expect(h.ctx.tools.get('mcp__beta__inspect', h.agent, retried.toolSet)).toBeUndefined()
})

it('defers every tool of a namespace that cannot fit as a whole and keeps transient exclusions on registry changes', async () => {
  const h = await setup('ptc', {
    capacity: 2, descriptionSize: 1000, budgetMode: 'enforce',
    budget: schemas => catalog.estimateSurfaceTokens(schemas.filter(tool => tool.name !== 'conditional' && (!tool.name.startsWith('mcp__') || tool.name.startsWith('mcp__alpha__')))),
  })
  h.register('mcp__alpha__second')
  const activation = await h.activate('alpha')
  expect(activation.isError).toBe(false)
  expect(activation.content[0]?.type).toBe('text')
  const firstBlock = activation.content[0]
  if (firstBlock?.type !== 'text') throw new Error('expected activation text')
  expect(firstBlock.text).toContain('requested')
  const admitted = await h.assemble()
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent, admitted.toolSet)).toBeUndefined()
  expect(h.ctx.tools.get('mcp__alpha__second', h.agent, admitted.toolSet)).toBeUndefined()
  h.register('mcp__gamma__inspect')
  expect(h.ctx.tools.get('mcp__alpha__inspect', h.agent, admitted.toolSet)).toBeUndefined()
  expect(h.ctx.tools.get('tool_activate', h.agent, admitted.toolSet)).toBeDefined()
})

it('fails request preparation when resident schemas alone exceed an enforced budget without hiding residents', async () => {
  const h = await setup('ptc', { budgetMode: 'enforce', budget: 1 })
  await expect(h.assemble()).rejects.toMatchObject({ code: 'LIANGSHEN_RESIDENT_BUDGET_EXCEEDED' })
  expect(h.ctx.tools.schemas(h.agent).map(tool => tool.name)).toEqual(['read', 'conditional', 'tool_activate'])
})

/** Compatibility replay exercises the same settlement normalizer and reducer as the projection. */
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

it('replays only matched successful settlements, retaining pending activations across an immutable snapshot', () => {
  const h = replayFixture()
  const pending = h.call('tool_activate', { namespace: 'alpha' })
  const failed = h.call('tool_activate', { namespace: 'beta' })
  h.settle(failed, true)
  h.settle(ToolCallId('no-preceding-call'))
  const interrupted = h.session.snapshotEvents()
  expect(paging.replayActivations(interrupted)).toEqual({ active: [], evicted: [] })
  h.settle(pending)
  expect(h.replay()).toEqual({ active: ['alpha'], evicted: [] })
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

it('returns the original paging array for irrelevant or already-most-recent calls', () => {
  const active = ['alpha']
  const options = { patterns: ['mcp__*'], capacity: 2 }
  expect(paging.applyPaging(active, { name: 'read', arguments: {} }, options)).toBe(active)
  expect(paging.applyPaging(active, { name: 'mcp__beta__inspect', arguments: {} }, options)).toBe(active)
  expect(paging.applyPaging(active, { name: 'mcp__alpha__inspect', arguments: {} }, options)).toBe(active)
})
