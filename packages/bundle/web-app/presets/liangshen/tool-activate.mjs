/** Activation of inherited MCP namespaces for the next admitted request. */
import z from '@deepseek-ai/schemastery'
import { scopeChainOf } from '@deepseek-ai/dsh-scope'
import { integerAtLeast, namespaceOf, replayActivations, validatePagedToolPatterns } from './paging.mjs'

/** Loader identity. */
export const name = 'liangshen-tool-activate'
/** Registry dependency. */
export const inject = ['tools']
/** Paging settings must match the catalog and working-context rows. */
export const Config = z.object({
  pagedToolPatterns: z.array(z.string()).default(['mcp__*']),
  maxActiveNamespaces: z.natural().min(1).default(3),
})

/** Register the activation tool; successful calls are replayed from the durable log. */
export function apply(ctx, config = {}) {
  const patterns = validatePagedToolPatterns(name, config.pagedToolPatterns)
  const capacity = integerAtLeast(name, config.maxActiveNamespaces, 'maxActiveNamespaces', 1, 3)
  ctx.effect(() => ctx.tools.register({
    name: 'tool_activate',
    description: `Activate a paged namespace named in the tool catalog. Its tools become callable from the next request, including through run_code. At most ${capacity} namespaces stay active; the least recently used is evicted.`,
    parameters: {
      type: 'object', properties: { namespace: { type: 'string', description: 'Exact namespace from the inactive tool catalog.' } },
      required: ['namespace'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      if (exec.agent === undefined) throw new Error('tool_activate requires a session')
      if (typeof args?.namespace !== 'string' || args.namespace.trim() === '') throw new Error('namespace must be a non-empty string')
      const namespace = args.namespace
      const parent = scopeChainOf(exec.agent)[1]
      const available = new Set(ctx.tools.schemas(parent).map(tool => namespaceOf(tool.name, patterns)).filter(Boolean))
      if (!available.has(namespace)) throw new Error(`Unknown paged namespace "${namespace}". Available: ${[...available].sort().join(', ') || '(none)'}`)
      const events = exec.agent.session.snapshotEvents().filter(event => !(event.type === 'tool/call' && event.data.callId === exec.callId))
      const { active } = replayActivations(events, capacity, patterns)
      if (active.includes(namespace)) throw new Error(`Namespace "${namespace}" is already active`)
      const evicted = active.length >= capacity ? active[0] : undefined
      return { text: `Activated "${namespace}" for the next request.${evicted === undefined ? '' : ` Paged out "${evicted}" (least recently used).`}` }
    },
  }), 'liangshen.tool-activate')
}
