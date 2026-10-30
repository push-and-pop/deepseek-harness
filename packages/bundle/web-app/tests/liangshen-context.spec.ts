/** Prompt and fact-ledger behavior in Liangshen mode. */
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import { expect, it, onTestFinished } from 'vitest'

const prompt = await import(new URL('../presets/liangshen/minimal-prompt.mjs', import.meta.url).href)
const ledger = await import(new URL('../presets/liangshen/fact-ledger.mjs', import.meta.url).href)
const context = await import(new URL('../presets/liangshen/working-context.mjs', import.meta.url).href)

it('keeps plan policy and executor SDK without unrelated guidance or duplicate instructions', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Helpful engineer.' })
  for (const [name, text] of [
    ['plan:policy', 'Plan before mutation.'],
    ['tools:sdk', 'SDK declarations.'], ['tools:ptc-only', 'Use run_code.'], ['other:guidance', 'Do not retain.'],
  ]) ctx.systemPrompt.section({ name: name!, text: text!, order: 1 })
  await ctx.plugin(prompt, { dispatcher: false })
  const assembly = await ctx.systemPrompt.assemble()
  expect(assembly.sections).toMatchInlineSnapshot(`
    [
      {
        "interpolate": false,
        "name": "deployment:persona-prefix",
        "text": "Helpful engineer.",
      },
      {
        "name": "plan:policy",
        "text": "Plan before mutation.",
      },
      {
        "name": "tools:ptc-only",
        "text": "Use run_code.",
      },
      {
        "name": "tools:sdk",
        "text": "SDK declarations.",
      },
    ]
  `)
})

it('replays only settled successful facts and supports revocation', () => {
  const events = [
    { type: 'tool/call', data: { callId: '1', name: 'fact_register', arguments: JSON.stringify({ fact: 'Use TypeScript', tag: 'language' }) } },
    { type: 'tool/result', data: { message: { source: { callId: '1' }, isError: false } } },
    { type: 'tool/call', data: { callId: '2', name: 'fact_register', arguments: JSON.stringify({ fact: 'Failed fact' }) } },
    { type: 'tool/result', data: { message: { source: { callId: '2' }, isError: true } } },
    { type: 'tool/call', data: { callId: '3', name: 'fact_register', arguments: JSON.stringify({ fact: 'Unsettled' }) } },
  ]
  expect(ledger.foldFactLedger(events)).toEqual([{ text: 'Use TypeScript', tag: 'language' }])
  expect(context.renderWorkingContext(events)).toBe('[Working Context: key facts: Use TypeScript [language]]')
  events.push(
    { type: 'tool/call', data: { callId: '4', name: 'fact_register', arguments: JSON.stringify({ revoke: 'language' }) } },
    { type: 'tool/result', data: { message: { source: { callId: '4' }, isError: false } } },
  )
  expect(ledger.foldFactLedger(events)).toEqual([])
})

it('unregisters the fact tool when its plugin unloads', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  const fiber = ctx.plugin(ledger)
  await fiber
  expect(ctx.tools.schemas().map(tool => tool.name)).toContain('fact_register')
  await fiber.dispose()
  expect(ctx.tools.schemas()).toEqual([])
})
