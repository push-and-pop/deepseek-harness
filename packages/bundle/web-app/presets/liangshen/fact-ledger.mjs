/** Deep's bounded fact register. Durable successful settlements own all updates. */
import { createHash } from 'node:crypto'
import { settleEvent } from './settlements.mjs'

export const name = 'liangshen-fact-ledger'
export const inject = ['tools', 'liangshenState']
export const FACT_LEDGER_TOOL = 'fact_register'

/** Defaults used by the shared state Config and detached replay. */
export const DEFAULT_FACT_OPTIONS = Object.freeze({ maxFacts: 12, maxFactChars: 160, maxTagChars: 48, maxLedgerChars: 2200 })

function historicalLine(value, limit) {
  return [...value.trim().replace(/[\r\n\u2028\u2029]+/gu, ' ')].slice(0, limit).join('')
}

/** Render fact values; registration metadata and separators count toward the budget. */
export function renderLedgerField(facts) {
  if (facts.length === 0) return undefined
  return `key facts: ${facts.map(entry => entry.tag === undefined ? entry.text : `${entry.text} [${entry.tag}]`).join(' ; ')}`
}

/** Apply one successful fact operation, evicting complete oldest entries when over budget. */
export function applyFact(facts, call, options = DEFAULT_FACT_OPTIONS) {
  if (call.name !== FACT_LEDGER_TOOL || call.arguments === null || typeof call.arguments !== 'object') return facts
  const args = call.arguments
  if (typeof args.revoke === 'string' && args.revoke.trim() !== '') {
    const key = historicalLine(args.revoke, Math.max(options.maxTagChars, options.maxFactChars))
    const rawKey = args.revoke.trim()
    const legacyKey = createHash('sha256').update(rawKey).digest('hex')
    const next = facts.filter(entry => entry.text !== key && entry.tag !== rawKey && entry.legacyTagKey !== legacyKey)
    return next.length === facts.length ? facts : next
  }
  if (typeof args.fact !== 'string' || args.fact.trim() === '') return facts
  const text = historicalLine(args.fact, options.maxFactChars)
  if (facts.some(entry => entry.text === text)) return facts
  const tag = typeof args.tag === 'string' ? historicalLine(args.tag, options.maxTagChars) : ''
  const rawTag = typeof args.tag === 'string' ? args.tag.trim() : ''
  // Old successful calls had no tag limit; retain their revocation identity without retaining huge tags.
  const legacyTagKey = tag !== rawTag ? createHash('sha256').update(rawTag).digest('hex') : undefined
  const entry = tag === '' ? { text } : { text, tag, ...legacyTagKey === undefined ? {} : { legacyTagKey } }
  const next = [...facts, entry].slice(-options.maxFacts)
  while (next.length > 0 && [...renderLedgerField(next)].length > options.maxLedgerChars) next.shift()
  return next
}

/** Detached replay uses the same settlement normalizer and reducer as the registered projection. */
export function foldFactLedger(events, options = DEFAULT_FACT_OPTIONS) {
  let pending = {}
  let facts = []
  for (const event of events) {
    const settled = settleEvent(pending, event, tool => tool === FACT_LEDGER_TOOL)
    pending = settled.pending
    if (settled.call !== undefined) facts = applyFact(facts, settled.call, options)
  }
  return facts
}

function inputLine(value, label, limit) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty string`)
  const line = value.trim()
  if (/[\r\n\u2028\u2029]/u.test(line)) throw new Error(`${label} must be a single line`)
  if ([...line].length > limit) throw new Error(`${label} must not exceed ${limit} characters`)
  return line
}

/** Register a validation-only operation; pending or failed calls never alter the register. */
export function apply(ctx) {
  const options = ctx.liangshenState.factOptions()
  ctx.effect(() => ctx.tools.register({
    name: FACT_LEDGER_TOOL,
    description: 'Record a key constraint or verified fact for later steps, or revoke old facts. Facts are reminders, not current evidence: recheck subjects that changed. Oldest facts may be evicted to keep the register within its budget.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        fact: {
          type: 'string', minLength: 1, maxLength: options.maxFactChars,
          description: `Single-line fact, at most ${options.maxFactChars} characters. Omit when revoking; duplicate text is unchanged.`,
        },
        tag: {
          type: 'string', minLength: 1, maxLength: options.maxTagChars,
          description: `Optional single-line topic, at most ${options.maxTagChars} characters. Several facts may share a tag.`,
        },
        revoke: {
          type: 'string', minLength: 1, maxLength: Math.max(options.maxFactChars, options.maxTagChars),
          description: 'Remove all facts with this tag or exact fact text. Takes precedence over fact and tag.',
        },
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      if (typeof args?.revoke === 'string' && args.revoke.trim() !== '') {
        const key = inputLine(args.revoke, 'revoke', Math.max(options.maxFactChars, options.maxTagChars))
        return { text: `Revocation recorded for ${JSON.stringify(key)}; the next working context reflects the remaining facts.` }
      }
      const fact = inputLine(args?.fact, 'fact', options.maxFactChars)
      const tag = args?.tag === undefined ? undefined : inputLine(args.tag, 'tag', options.maxTagChars)
      return { text: `Fact recorded${tag === undefined ? '' : ` under ${JSON.stringify(tag)}`}: ${JSON.stringify(fact)}. The next working context applies the register's item and total-size limits.` }
    },
  }), 'liangshen.fact-ledger')
}
