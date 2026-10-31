/** Scoped Deep state owner, derived incrementally from committed Session events. */
import { createHash } from 'node:crypto'
import Schema from '@deepseek-ai/schemastery'
import { z } from 'zod'
import { settleEvent } from './settlements.mjs'
import { applyPaging, namespaceOf, validatePagedToolPatterns } from './paging.mjs'
import { applyFact, DEFAULT_FACT_OPTIONS, FACT_LEDGER_TOOL } from './fact-ledger.mjs'

export const name = 'liangshen-state'
export const inject = ['sessionProjections']
export const Config = Schema.object({
  pagedToolPatterns: Schema.array(Schema.string()).default(['mcp__*']),
  maxActiveNamespaces: Schema.natural().min(1).default(3),
  maxFacts: Schema.natural().min(1).default(DEFAULT_FACT_OPTIONS.maxFacts),
  maxFactChars: Schema.natural().min(1).default(DEFAULT_FACT_OPTIONS.maxFactChars),
  maxTagChars: Schema.natural().min(1).default(DEFAULT_FACT_OPTIONS.maxTagChars),
  maxLedgerChars: Schema.natural().min(32).default(DEFAULT_FACT_OPTIONS.maxLedgerChars),
  maxTodoTitles: Schema.natural().min(1).default(3),
  maxTodoChars: Schema.natural().min(1).default(80),
})

const factSchema = z.object({ text: z.string(), tag: z.string().optional(), legacyTagKey: z.string().optional() })
const publicationSchema = z.object({ seq: z.number(), step: z.number(), text: z.string(), visible: z.boolean() })
const stateSchema = z.object({
  pending: z.record(z.string(), z.object({ name: z.string(), arguments: z.unknown() })),
  active: z.array(z.string()), facts: z.array(factSchema),
  plan: z.object({ seen: z.boolean(), active: z.boolean() }),
  todos: z.array(z.string()), moreTodos: z.number(), stepCount: z.number(),
  published: z.object({ catalog: publicationSchema.optional(), context: publicationSchema.optional() }),
})

function singleLine(value, limit) {
  return [...value.trim().replace(/[\r\n\u2028\u2029]+/gu, ' ')].slice(0, limit).join('')
}

/** Build one deterministic host-only projection; no runtime effects occur during replay. */
export function createDeepStateDefinition(config) {
  const paging = { patterns: config.pagedToolPatterns, capacity: config.maxActiveNamespaces }
  const accepts = tool => tool === FACT_LEDGER_TOOL || tool === 'tool_activate' || namespaceOf(tool, paging.patterns) !== undefined
  const canonical = Object.fromEntries(Object.entries(config).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
  const key = createHash('sha256').update(JSON.stringify(canonical)).digest('hex')
  return {
    key: `liangshen.state.${key}`, stateVersion: 1, stateSchema,
    init: () => ({
      pending: {}, active: [], facts: [], plan: { seen: false, active: false },
      todos: [], moreTodos: 0, stepCount: 0, published: {},
    }),
    apply(state, event) {
      const settled = settleEvent(state.pending, event, accepts)
      const active = settled.call === undefined ? state.active : applyPaging(state.active, settled.call, paging)
      const facts = settled.call === undefined ? state.facts : applyFact(state.facts, settled.call, config)
      let next = settled.pending === state.pending && active === state.active && facts === state.facts
        ? state : { ...state, pending: settled.pending, active, facts }
      if (typeof event.surfaceOp === 'object') {
        const { startSeq, endSeq } = event.surfaceOp
        for (const slot of ['catalog', 'context']) {
          const entry = next.published[slot]
          if (entry?.visible && entry.seq >= startSeq && entry.seq <= endSeq) {
            next = { ...next, published: { ...next.published, [slot]: { ...entry, visible: false } } }
          }
        }
      }
      if (event.type === 'step/start') next = { ...next, stepCount: next.stepCount + 1 }
      if (event.type === 'turn/start' && (next.todos.length > 0 || next.moreTodos > 0)) next = { ...next, todos: [], moreTodos: 0 }
      if (event.type === 'plan/mode') next = { ...next, plan: { seen: true, active: event.data.active } }
      if (event.type === 'todo/write') {
        const inProgress = event.data.todos.filter(item => item.status === 'in_progress')
        next = {
          ...next,
          todos: inProgress.slice(0, config.maxTodoTitles).map(item => singleLine(item.content, config.maxTodoChars)),
          moreTodos: Math.max(0, inProgress.length - config.maxTodoTitles),
        }
      }
      if (event.type === 'user/message') {
        const source = event.data.source
        const kind = source.kind === 'plugin' ? source.plugin : source.kind
        const slot = kind === 'liangshen-working-context' ? 'context' : kind === 'liangshen-tool-catalog' ? 'catalog' : undefined
        if (slot !== undefined) {
          const text = event.data.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
          next = { ...next, published: { ...next.published, [slot]: { seq: event.seq, step: next.stepCount, text, visible: true } } }
        }
      }
      return next
    },
  }
}

/** Await projection readiness before publishing synchronous domain readers. */
export async function apply(ctx, input) {
  const config = Config(input ?? {})
  config.pagedToolPatterns = validatePagedToolPatterns(name, config.pagedToolPatterns)
  if (config.maxLedgerChars < config.maxFactChars + config.maxTagChars + 16) {
    throw new Error('liangshen-state: maxLedgerChars must fit one maximum-size fact, tag, and field separators')
  }
  const handle = await ctx.sessionProjections.register(createDeepStateDefinition(config))
  const paging = Object.freeze({ patterns: config.pagedToolPatterns, capacity: config.maxActiveNamespaces })
  const facts = Object.freeze({
    maxFacts: config.maxFacts, maxFactChars: config.maxFactChars,
    maxTagChars: config.maxTagChars, maxLedgerChars: config.maxLedgerChars,
  })
  ctx.provide('liangshenState', {
    /** Read-only canonical paging settings shared by every consumer. */
    pagingOptions: () => paging,
    /** Requested namespaces in successful-settlement LRU order, oldest first. */
    paging: session => ({ active: handle.stateOf(session).active }),
    /** Read-only register bounds used by validation and replay. */
    factOptions: () => facts,
    /** Read the currently pinned facts without reading the Session log. */
    facts: session => handle.stateOf(session).facts,
    /** Read bounded plan/task state and admitted-step count. */
    context(session) {
      const state = handle.stateOf(session)
      return { plan: state.plan, todos: state.todos, moreTodos: state.moreTodos, stepCount: state.stepCount }
    },
    /** Latest durable publication, even if compaction removed its visible node. */
    published: (session, kind) => handle.stateOf(session).published[kind],
  })
}
