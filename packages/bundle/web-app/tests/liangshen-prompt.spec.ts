/** Liangshen dispatcher detail and the exact model-visible prompt policy. */
import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import type Schema from '@deepseek-ai/schemastery'
import { expect, it, onTestFinished } from 'vitest'

interface PromptConfig {
  keepPlanPolicy?: boolean
  dispatcher?: boolean
  dispatcherDetail?: 'compact' | 'full'
}

interface PromptModule {
  name: string
  inject: string[]
  Config: Schema<unknown, Required<PromptConfig>>
  apply(ctx: Context, config?: PromptConfig): void
}

const prompt = await import(new URL('../presets/liangshen/minimal-prompt.mjs', import.meta.url).href) as PromptModule
const rules = await import(new URL('../presets/liangshen/dispatcher-rules.mjs', import.meta.url).href) as {
  DISPATCHER_RULES_COMPACT: string
  DISPATCHER_RULES_WITH_APPENDIX: string
}

async function setup(config?: PromptConfig) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SystemPrompt, { personaPrefix: 'Helpful engineer.' })
  for (const [name, text] of [
    ['plan:policy', 'Plan before mutation.'],
    ['tool:goal', 'Host goal lifecycle policy.'],
    ['tools:sdk', 'SDK declarations.'],
    ['tools:ptc-only', 'Use run_code.'],
    ['other:guidance', 'Do not retain.'],
    ['future:unknown', 'Unknown prose is not implicitly retained.'],
  ] as const) ctx.systemPrompt.section({ name, text, order: 1 })
  for (const [name, text] of [
    ['sandbox:policy', 'Read-only filesystem policy.'],
    ['approval:policy', 'Approval prompts are disabled.'],
    ['subagent:delegation', 'Delegated authority is fixed.'],
    ['future:runtime', 'Future runtime facts.'],
  ] as const) ctx.systemPrompt.context({ name, text, order: 1, interpolate: false })
  ctx.systemPrompt.variable('project', () => 'workspace')
  ctx.systemPrompt.tools(() => ({ schemas: [{
    name: 'inspect_fixture', description: 'Inspect fixture.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  }] }))
  const scope = { session: { header: { cwd: 'F:\\workspace\\{{literal}}' } } }
  const before = await ctx.systemPrompt.assemble({ scope })
  const fiber = ctx.plugin(prompt, config)
  await fiber
  return { ctx, fiber, scope, before }
}

it('defaults to a bounded compact block and preserves the opt-in full text verbatim', () => {
  expect(prompt.Config({})).toEqual({ keepPlanPolicy: true, dispatcher: true, dispatcherDetail: 'compact' })
  expect(prompt.Config({ dispatcher: false, dispatcherDetail: 'full' })).toEqual({
    keepPlanPolicy: true, dispatcher: false, dispatcherDetail: 'full',
  })
  expect(rules.DISPATCHER_RULES_COMPACT.length).toBeLessThanOrEqual(3000)
  expect(rules.DISPATCHER_RULES_COMPACT.length).toBeLessThan(rules.DISPATCHER_RULES_WITH_APPENDIX.length * 0.2)
  expect(rules.DISPATCHER_RULES_WITH_APPENDIX.length).toBe(29533)
  expect(createHash('sha256').update(rules.DISPATCHER_RULES_WITH_APPENDIX).digest('hex'))
    .toBe('19ae8fb0d237f82d4fc299981d9ce233ddde9dfa89c28d7ed69faa96106b984e')
})

it.each(['verbose', '', false, 1])('rejects invalid dispatcherDetail %j at configuration validation', (dispatcherDetail) => {
  expect(() => prompt.Config({ dispatcherDetail })).toThrow()
})

it('pins the complete default compact sections while preserving Host contexts and tool declarations', async () => {
  const { ctx, scope, before } = await setup()
  const assembly = await ctx.systemPrompt.assemble({ scope })
  expect(assembly.sections).toMatchInlineSnapshot(`
    [
      {
        "interpolate": false,
        "name": "deployment:persona-prefix",
        "text": "Helpful engineer.

    Your working directory is F:\\workspace\\{{literal}}.

    ## Delegation discipline

    - Follow Host instructions, current permissions, and the tools' own definitions before this guidance. They govern goals, delegation, routing, and tool availability; do not infer authority from a tool being listed or bypass a denial. Before a destructive or irreversible action, verify its target and effects and obtain user confirmation unless that exact action is already authorized.
    - Clarify only missing user-owned decisions that materially affect scope, risk, implementation, or acceptance. Inspect discoverable facts yourself. Clear requirements, including complex ones, need no interview or repeated sign-off; state safe, reversible assumptions and proceed. Do not print mandatory tier or routing status.
    - Use a brief plan for multi-step work. Execute directly when delegation has no useful parallelism or independent-review value. Complexity alone does not require subagents. As a delegated executor, stay within the assigned scope and report evidence to the parent.
    - Run independent inspections, searches, and checks in parallel when safe; sequence dependent work. Delegate only bounded, useful tasks. Each brief states the goal, allowed files or modules, constraints, acceptance criteria, and evidence to return; make any quantitative limits explicit.
    - Give each writable file or shared resource one active owner. Do not edit a child's assigned files while it may still write, or dispatch overlapping writers. Agree on interfaces before dependent edits. Continue independent work while children run; follow the tools' waiting and completion semantics rather than polling or duplicating their work.
    - A child failure or rejected dispatch does not require repeated redispatch. Diagnose the cause, then choose a targeted retry, narrower task, or direct takeover within your authority. Before takeover, ensure the prior writer has stopped and inspect partial changes. Do not loop on the same failure or evade permission, route, or depth limits; if no safe path remains, report the concrete blocker or ask for the needed decision.
    - Treat child reports and pinned facts as evidence to check, not proof of completion or current state. Re-read changed subjects, review relevant diffs, and verify acceptance with focused tests or other direct checks. Resolve known defects or explicitly obtain a scope decision; report what changed, checks actually run, and remaining risks or verification limits. Never claim success from a completion notification alone.",
      },
      {
        "name": "plan:policy",
        "text": "Plan before mutation.",
      },
      {
        "name": "tool:goal",
        "text": "Host goal lifecycle policy.",
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
  expect(assembly.sections[0]?.text).toBe(`Helpful engineer.\n\nYour working directory is F:\\workspace\\{{literal}}.\n\n${rules.DISPATCHER_RULES_COMPACT}`)
  expect(assembly.contexts).toEqual(before.contexts)
  expect(assembly.tools).toEqual(before.tools)
  expect(assembly.variables).toEqual(before.variables)
})

it.each(['compact', 'full'] as const)('dispatcher false omits %s guidance but keeps cwd, plan policy, goal policy and SDK', async (dispatcherDetail) => {
  const { ctx, scope } = await setup({ dispatcher: false, dispatcherDetail })
  const assembly = await ctx.systemPrompt.assemble({ scope })
  expect(assembly.sections).toEqual([
    { name: 'deployment:persona-prefix', text: 'Helpful engineer.\n\nYour working directory is F:\\workspace\\{{literal}}.', interpolate: false },
    { name: 'plan:policy', text: 'Plan before mutation.' },
    { name: 'tool:goal', text: 'Host goal lifecycle policy.' },
    { name: 'tools:ptc-only', text: 'Use run_code.' },
    { name: 'tools:sdk', text: 'SDK declarations.' },
  ])
})

it.each(['compact', 'full'] as const)('selects exactly the requested %s block without changing the remaining assembly', async (dispatcherDetail) => {
  const { ctx, scope, before } = await setup({ dispatcherDetail })
  const assembly = await ctx.systemPrompt.assemble({ scope })
  const selected = dispatcherDetail === 'full' ? rules.DISPATCHER_RULES_WITH_APPENDIX : rules.DISPATCHER_RULES_COMPACT
  expect(assembly.sections[0]).toEqual({
    name: 'deployment:persona-prefix',
    text: `Helpful engineer.\n\nYour working directory is F:\\workspace\\{{literal}}.\n\n${selected}`,
    interpolate: false,
  })
  expect(assembly.sections.slice(1)).toEqual(before.sections.filter(section =>
    ['plan:policy', 'tool:goal', 'tools:sdk', 'tools:ptc-only'].includes(section.name)))
  expect(assembly.contexts).toEqual(before.contexts)
  expect(assembly.tools).toEqual(before.tools)
})

it('allows plan policy omission explicitly, without removing goal policy or SDK', async () => {
  const { ctx, scope } = await setup({ dispatcher: false, keepPlanPolicy: false })
  expect((await ctx.systemPrompt.assemble({ scope })).sections).toEqual([
    { name: 'deployment:persona-prefix', text: 'Helpful engineer.\n\nYour working directory is F:\\workspace\\{{literal}}.', interpolate: false },
    { name: 'tool:goal', text: 'Host goal lifecycle policy.' },
    { name: 'tools:ptc-only', text: 'Use run_code.' },
    { name: 'tools:sdk', text: 'SDK declarations.' },
  ])
})

it('omits unavailable cwd and unregisters its filtering on plugin unload', async () => {
  const { ctx, fiber, before } = await setup({ dispatcher: false })
  expect((await ctx.systemPrompt.assemble()).sections[0]).toEqual({
    name: 'deployment:persona-prefix', text: 'Helpful engineer.', interpolate: false,
  })
  await fiber.dispose()
  expect(await ctx.systemPrompt.assemble()).toEqual(before)
})
