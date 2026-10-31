/** Request inherited namespace activation for the next admitted request. */
import { scopeChainOf } from '@deepseek-ai/dsh-scope'
import { namespaceOf } from './paging.mjs'

/** Loader identity. */
export const name = 'liangshen-tool-activate'
/** Tool registration and the preset's canonical projected paging state. */
export const inject = ['tools', 'liangshenState']

/**
 * Register activation requests; successful native and PTC settlements update state.
 * @param {object} ctx - Cordis context with tools and Liangshen state.
 * @returns {void} The tool is removed with its owning fiber.
 */
export function apply(ctx) {
  const { patterns, capacity } = ctx.liangshenState.pagingOptions()
  ctx.effect(() => ctx.tools.register({
    name: 'tool_activate',
    description: `Request a registered namespace from the tool catalog for the next admission, including through run_code. Repeating an active namespace refreshes its recency. At most ${capacity} namespaces stay active; the oldest is evicted. Session policies, tool conditions and the configured schema budget may still withhold tools.`,
    parameters: {
      type: 'object', properties: { namespace: { type: 'string', description: 'Exact registered namespace from the tool catalog.' } },
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
      if (!available.has(namespace)) throw new Error(`Unknown registered namespace "${namespace}". Available: ${[...available].sort().join(', ') || '(none)'}`)
      const { active } = ctx.liangshenState.paging(exec.agent.session)
      return { text: `${active.includes(namespace) ? 'Recency refresh' : 'Activation'} requested for "${namespace}" at the next admission. The namespace limit or schema budget may defer older namespaces; session policies and tool conditions still apply.` }
    },
  }), 'liangshen.tool-activate')
}
