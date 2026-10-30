/** Liangshen prompt policy. Workspace instructions remain owned by the Host. */
import z from '@deepseek-ai/schemastery'
import { DISPATCHER_RULES_WITH_APPENDIX } from './dispatcher-rules.mjs'

/** Loader identity. */
export const name = 'liangshen-minimal-prompt'
/** Prompt registry dependency. */
export const inject = ['systemPrompt']
/** Keep execution policy and optional dispatcher discipline explicit. */
export const Config = z.object({
  keepPlanPolicy: z.boolean().default(true),
  dispatcher: z.boolean().default(true),
})

/** Narrow prose without altering runtime context or executor-owned tool declarations. */
export function apply(ctx, config = {}) {
  const keepPlanPolicy = config.keepPlanPolicy ?? true
  const dispatcher = config.dispatcher ?? true
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const persona = assembled.sections.find(section => section.name === 'deployment:persona-prefix')
    if (persona === undefined) throw new Error('Liangshen requires a persona prefix')
    const agent = context.scope
    const cwd = agent?.session === undefined ? undefined
      : ctx.get('workingDirectory')?.get(agent.session) ?? agent.session.header.cwd
    const suffix = [
      typeof cwd === 'string' ? `Your working directory is ${cwd}.` : '',
      dispatcher ? DISPATCHER_RULES_WITH_APPENDIX : '',
    ].filter(Boolean).join('\n\n')
    return {
      ...assembled,
      sections: assembled.sections.filter(section =>
        section === persona
        || (keepPlanPolicy && section.name === 'plan:policy')
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
