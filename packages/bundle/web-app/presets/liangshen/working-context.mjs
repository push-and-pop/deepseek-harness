/** Budgeted, periodically refreshed Deep context from the shared incremental projection. */
import z from '@deepseek-ai/schemastery'
import { renderLedgerField } from './fact-ledger.mjs'

export const name = 'liangshen-working-context'
export const inject = ['liangshenState']
export const Config = z.object({
  maxContextChars: z.natural().min(128).default(3000),
  refreshAfterSteps: z.natural().min(1).default(4),
})

const CLEARED = '[Working Context: empty; earlier working context no longer applies.]'
const characters = value => [...value].length

/** Render the complete bounded message, dropping whole oldest facts before other clipping. */
export function renderWorkingContext(snapshot, options = {}) {
  if (!snapshot.plan.seen && snapshot.active.length === 0 && snapshot.todos.length === 0 && snapshot.facts.length === 0) return undefined
  const limit = options.maxContextChars ?? 3000
  const facts = [...snapshot.facts]
  let omitted = 0
  const render = () => {
    const fields = []
    if (snapshot.plan.seen) fields.push(`plan mode: ${snapshot.plan.active ? 'on' : 'off'}`)
    const ledger = renderLedgerField(facts)
    if (ledger !== undefined) fields.push(ledger)
    if (omitted > 0) fields.push(`older facts omitted: ${omitted}`)
    if (snapshot.active.length > 0) fields.push(`requested namespaces: ${snapshot.active.join(', ')}`)
    if (snapshot.todos.length > 0) {
      const rest = snapshot.moreTodos > 0 ? `; +${snapshot.moreTodos} more` : ''
      fields.push(`in progress: ${snapshot.todos.join('; ')}${rest}`)
    }
    return `[Working Context: ${fields.join(' | ')} | supersedes earlier working context]`
  }
  let text = render()
  while (characters(text) > limit && facts.length > 0) {
    facts.shift()
    omitted += 1
    text = render()
  }
  if (characters(text) <= limit) return text
  const suffix = ' … [truncated; supersedes earlier context]]'
  return [...text].slice(0, limit - characters(suffix)).join('') + suffix
}

function isContext(message) {
  return message.source.kind === name || (message.source.kind === 'plugin' && message.source.plugin === name)
}

function textOf(message) {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/** Build a normal durable user message; admission, cancellation, and logging stay Host-owned. */
export function createContextMessage(text) {
  return { id: globalThis.crypto.randomUUID(), role: 'user', content: [{ type: 'text', text }], source: { kind: name } }
}

/** Add changed, hidden, or aged context; explicitly supersede a register that became empty. */
export function apply(ctx, input) {
  const config = Config(input ?? {})
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const state = ctx.liangshenState
    const context = state.context(agent.session)
    const line = renderWorkingContext({
      ...context, active: state.paging(agent.session).active, facts: state.facts(agent.session),
    }, config)
    const previous = state.published(agent.session, 'context')
    if (line === undefined && previous === undefined) return decision
    const text = line ?? CLEARED
    const due = line !== undefined && previous !== undefined
      && context.stepCount + 1 - previous.step >= config.refreshAfterSteps
    if (previous?.visible && previous.text === text && !due) {
      return { ...decision, messages: decision.messages.filter(message => !isContext(message)) }
    }
    const existing = decision.messages.find(message => isContext(message) && textOf(message) === text)
    return {
      ...decision,
      messages: [...decision.messages.filter(message => !isContext(message)), existing ?? createContextMessage(text)],
    }
  }, { prepend: true })
}
