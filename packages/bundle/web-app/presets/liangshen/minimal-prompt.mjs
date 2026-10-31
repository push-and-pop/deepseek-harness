/** Liangshen prompt policy. Workspace instructions remain owned by the Host. */
import z from '@deepseek-ai/schemastery'
import { DISPATCHER_RULES_COMPACT, DISPATCHER_RULES_WITH_APPENDIX } from './dispatcher-rules.mjs'

/** Loader identity. */
export const name = 'liangshen-minimal-prompt'
/** Prompt registry dependency. */
export const inject = ['systemPrompt']
/** Keep execution policy and optional dispatcher discipline explicit. */
export const Config = z.object({
  /** Retain the Host's plan-mode policy; enabled by default. */
  keepPlanPolicy: z.boolean().default(true),
  /** Append dispatcher guidance by default; false disables both detail levels. */
  dispatcher: z.boolean().default(true),
  /** Compact is the default; full explicitly opts into the original interview and dispatch rules. Ignored when dispatcher is false. */
  dispatcherDetail: z.union([z.const('compact'), z.const('full')]).default('compact')
    .description('Dispatcher detail: compact (default) uses lightweight delegation; full opts into the original interview and dispatch rules. Ignored when dispatcher is false.'),
})

/** Narrow prose without altering runtime context or executor-owned tool declarations. */
export function apply(ctx, config = {}) {
  const { keepPlanPolicy, dispatcher, dispatcherDetail } = Config(config)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const persona = assembled.sections.find(section => section.name === 'deployment:persona-prefix')
    if (persona === undefined) throw new Error('Liangshen requires a persona prefix')
    const agent = context.scope
    const cwd = agent?.session === undefined ? undefined
      : ctx.get('workingDirectory')?.get(agent.session) ?? agent.session.header.cwd
    const suffix = [
      typeof cwd === 'string' ? `Your working directory is ${cwd}.` : '',
      dispatcher ? (dispatcherDetail === 'full' ? DISPATCHER_RULES_WITH_APPENDIX : DISPATCHER_RULES_COMPACT) : '',
    ].filter(Boolean).join('\n\n')
    return {
      ...assembled,
      sections: assembled.sections.filter(section =>
        section === persona
        || (keepPlanPolicy && section.name === 'plan:policy')
        || section.name === 'tool:goal'
        || section.name === 'tools:sdk'
        || section.name === 'tools:ptc-only',
      ).map(section => section === persona ? {
        ...section,
        text: [section.text, suffix].filter(Boolean).join('\n\n'),
        interpolate: false,
      } : section),
    }
  })
}
