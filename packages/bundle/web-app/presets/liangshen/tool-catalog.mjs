/** Compact, durable tool catalog with Agent-scoped namespace paging. */
import z from '@deepseek-ai/schemastery'
import {
  integerAtLeast, namespaceOf, partitionWireTools, replayActivations,
  summarizeInactive, validatePagedToolPatterns,
} from './paging.mjs'

/** Cordis plugin identity and durable message source. */
export const name = 'liangshen-tool-catalog'
/** Registries used for admission, paging and prompt observation. */
export const inject = ['systemPrompt', 'tools']
/** Validated deployment controls; presentation belongs to the selected executor. */
export const Config = z.object({
  descriptionMaxLength: z.natural().min(1).default(200),
  pagedToolPatterns: z.array(z.string()).default(['mcp__*']),
  maxActiveNamespaces: z.natural().min(1).default(3),
  maxResidentTokens: z.natural().min(1).default(8000),
})
const DEFAULT_DESCRIPTION_MAX_LENGTH = 200
const MAX_SIGNATURE_DEPTH = 4
const SCALAR_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'null'])

/** Estimate serialized schema tokens for the diagnostic budget. */
export function estimateSurfaceTokens(schemas) {
  return Math.ceil(schemas.reduce((total, schema) => total + JSON.stringify(schema).length, 0) / 4)
}
export const CURATED_TOOL_SUMMARIES = new Map([
  ['bash', 'Run a command in a fresh bash shell (`command`, optional `timeoutMs`, `workdir`, `run_in_background`).'],
  ['pwsh', 'Run a command in a fresh PowerShell process (`command`, optional `timeoutMs`, `workdir`, `run_in_background`); native Windows paths and `$env:NAME` variables.'],
  ['read', 'Read one UTF-8 text file as line-numbered content (`file_path`, optional `offset` and `limit`).'],
  ['read_image', 'Read a PNG/JPEG/WebP/GIF image file and return the image itself (`file_path`); large images are downscaled automatically.'],
  ['write', 'Create or fully replace one UTF-8 text file (`file_path`, `content`).'],
  ['edit', 'Replace literal text in one existing file (`file_path`, `old_string`, `new_string`, optional `replace_all`).'],
  ['str_replace_editor', 'View, create, and edit files through one command tool (`command`, `path`, plus `file_text`, `old_str` / `new_str`, `insert_line`, `view_range`).'],
  ['glob', 'Find files whose paths match a glob pattern (`pattern`, optional `path`); up to 100 paths in modification-time order.'],
  ['grep', 'Search file contents with a ripgrep expression (`pattern`, optional `path`, optional `include`); matching lines with line numbers.'],
  ['job_output', 'Read a background job: output since the previous read, or the finished result (`job_id`, optional `wait`, `timeout_ms`).'],
  ['job_list', 'List the background jobs started by this session with their ids, kinds, and statuses.'],
  ['job_kill', 'Request cancellation of a running background job (`job_id`, optional `reason`).'],
  ['todo_write', 'Record and update the plan as one todo per concrete step (`todos`: content and status); skip it for trivial single-step work.'],
  ['create_goal', 'Create a persisted goal that keeps this session working across automatic continuation rounds (`objective`, optional `max_goal_rounds`).'],
  ['get_goal', 'Read the current session goal, including the id and revision that update_goal requires.'],
  ['update_goal', 'Change one goal: edit, pause, resume, complete or blocked (`goal_id`, `revision`, `action`, plus `objective`, `max_goal_rounds`, `blocked_reason`).'],
  ['exit_plan_mode', 'Present the completed plan for user review (`plan`, markdown starting with a title); approval is the only way out of plan mode.'],
  ['subagent', 'Delegate a self-contained task to a subagent that works in its own context and returns its result, not its steps (`description`, `prompt`, optional `provider` / `model` / `reasoning_effort`).'],
  ['subagent_fork', 'Delegate a task to a subagent seeded with this conversation (`description`, `prompt`); it inherits the parent route, so route fields are not accepted.'],
  ['list_subagent_models', 'Discover the subagent routes this session authorizes (`provider`, optional `model`); the returned ids feed the delegation tools.'],
  ['send_message', 'Send a message to a subagent started from this session (`agent_id`, `message`); the call confirms delivery, not the answer.'],
  ['list_agents', 'List the subagents started from this session with their ids, labels, and status (`scope`).'],
  ['interrupt_agent', 'Ask a subagent to stop its current work (`agent_id`); the call returns without waiting for it to settle.'],
  ['ask_user_question', 'Ask the user a concise question and wait for the answer (`questions`: id, question, optional header, options, and custom input).'],
  ['web_search', 'Search the web for current information (one to four `queries`); returns a merged summary and its source URLs.'],
  ['skill', 'Load the full instructions of one session skill (`name`); call it before acting on a task that names or matches a skill.'],
  ['tool_activate', 'Load one paged tool namespace back onto the wire and into the generated SDK (`namespace`, exactly as the catalog names it).'],
  ['fact_register', 'Pin one key fact into the working context (`fact`, optional `tag`), or unpin with `revoke`; at most twelve short facts stay pinned.'],
  ['ralph', 'Run a foreground fresh-agent Ralph loop toward one immutable objective (`objective`, optional `maxRounds`); only when the human explicitly asks for it.'],
  ['list_mcp_resources', 'List the resources an MCP server exposes (`server`, optional `cursor`).'],
  ['list_mcp_resource_templates', 'List the parameterized resource URI templates of one MCP server (`server`, optional `cursor`).'],
  ['read_mcp_resource', 'Read one MCP resource by URI from the named server (`server`, `uri`).'],
])

/**
 * One-line model-facing summary of a tool description: whitespace collapsed,
 * truncated with an ellipsis when maxLength is specified.
 */
export function catalogDescription(value, maxLength) {
  const normalized = String(value ?? '').replaceAll(/\s+/g, ' ').trim()
  if (maxLength === undefined || maxLength <= 0 || normalized.length <= maxLength) return normalized
  return `${normalized.slice(0, maxLength - 3)}...`
}

/**
 * The one-line summary one entry renders for a tool: the curated line when the
 * table names it, otherwise the mechanically capped schema description. The
 * order is the whole point — curation first, truncation only as the fallback
 * for a tool nobody has written a line for yet.
 * @param {{ name?: unknown, description?: unknown }} schema - one tool definition.
 * @param {number} maxLength - the schema-description cap, in characters.
 * @returns the summary text for the catalog entry.
 */
export function toolSummary(schema, maxLength) {
  const name = schema?.name
  if (typeof name === 'string' && CURATED_TOOL_SUMMARIES.has(name)) {
    return CURATED_TOOL_SUMMARIES.get(name)
  }
  return catalogDescription(schema?.description, maxLength)
}

/** One scalar literal as TypeScript-ish text; non-JSON scalars degrade to the broad type. */
function renderLiteral(value) {
  const json = JSON.stringify(value)
  return json === undefined ? 'JsonValue' : json
}

/**
 * One JSON-Schema node as compact TypeScript-ish text for inline signatures.
 * Bounded by MAX_SIGNATURE_DEPTH so inline signatures remain single-line.
 */
export function renderJsonSchemaType(schema, depth = 0) {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return 'JsonValue'
  const union = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined
  if (union !== undefined && union.length > 0) {
    const parts = union.map(node => renderJsonSchemaType(node, depth))
    return [...new Set(parts)].join(' | ')
  }
  if (Object.hasOwn(schema, 'const')) return renderLiteral(schema.const)
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum.map(renderLiteral).join(' | ')
  if (Array.isArray(schema.type)) {
    const parts = schema.type.map(type => (typeof type === 'string' ? type : 'JsonValue'))
    return [...new Set(parts)].join(' | ')
  }
  if (SCALAR_TYPES.has(schema.type)) return schema.type === 'integer' ? 'number' : schema.type
  if (schema.type === 'array') {
    const items = schema.items === undefined ? 'JsonValue' : renderJsonSchemaType(schema.items, depth + 1)
    return items.includes('|') ? `(${items})[]` : `${items}[]`
  }
  if (schema.type === 'object' || schema.properties !== undefined) {
    if (depth >= MAX_SIGNATURE_DEPTH) return 'JsonValue'
    const properties = schema.properties !== undefined && typeof schema.properties === 'object' && !Array.isArray(schema.properties)
      ? Object.entries(schema.properties)
      : []
    if (properties.length === 0) return 'Record<string, JsonValue>'
    const required = new Set(Array.isArray(schema.required) ? schema.required : [])
    const fields = properties.map(([field, child]) => (
      `${field}${required.has(field) ? '' : '?'}: ${renderJsonSchemaType(child, depth + 1)}`
    ))
    return `{ ${fields.join(', ')} }`
  }
  return 'JsonValue'
}

/**
 * The parenthesized argument signature of one tool, e.g.
 * ({ command: string, timeoutMs?: number }). Empty when the parameter schema
 * carries nothing to say.
 */
export function renderSignature(parameters) {
  if (parameters === null || typeof parameters !== 'object' || Array.isArray(parameters)) return ''
  const type = renderJsonSchemaType(parameters)
  return type === 'JsonValue' ? '' : `(${type})`
}

/**
 * Catalog entries for one tool surface, sorted by name so an unchanged surface
 * renders byte-identical text across assemblies. Nameless definitions are
 * skipped; the `run_code` transport never renders as an entry — under `ptc`
 * the program contract describes it, under `native` the request does not
 * carry it. Each entry's summary is resolved by {@link toolSummary}: the
 * curated line where the table has one, the capped schema description
 * otherwise.
 */
export function catalogEntries(schemas, maxLength, options) {
  const patterns = Array.isArray(options?.patterns) ? options.patterns : []
  const entries = []
  for (const schema of Array.isArray(schemas) ? schemas : []) {
    const toolName = schema?.name
    if (typeof toolName !== 'string' || toolName === '') continue
    if (toolName === 'run_code') continue
    // A tool from a paged family carries its namespace so the catalog can group
    // it the way the model calls it, instead of scattering one server's tools
    // through an alphabetical list.
    const namespace = namespaceOf(toolName, patterns)
    entries.push({
      name: toolName,
      signature: renderSignature(schema.parameters),
      description: toolSummary(schema, maxLength),
      ...(namespace === undefined ? {} : { namespace }),
    })
  }
  return entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

const PTC_PROGRAM_LINES = [
  'Only `run_code` is directly callable. Reach the listed capabilities through the generated SDK; follow its program format and the `run_code` input schema.',
  'Batch independent read-only calls in one program and return only the evidence needed for the next decision.',
  'Inactive namespaces are absent from the SDK and cannot be invoked until activated. Activation takes effect on the next request.',
]
/**
 * Model-facing catalog text.
 * - Native presentation: the on-wire tool list plus the paged-out namespace
 *   summary with its wire-only reachability.
 * - 'ptc' (wire collapsed to `run_code`): the SDK-reachable list plus the full
 *   program contract naming `run_code` the one direct transport, and a
 *   namespace summary whose page covers the whole surface.
 */
export function renderCatalogText(entries, presentation = 'native', inactive = []) {
  // Activated paged families are listed under their namespace heading; every
  // other tool stays in the flat alphabetical list, so an unchanged surface
  // still renders byte-identical text.
  const resident = entries.filter(entry => entry.namespace === undefined)
  const byNamespace = new Map()
  for (const entry of entries) {
    if (entry.namespace === undefined) continue
    if (!byNamespace.has(entry.namespace)) byNamespace.set(entry.namespace, [])
    byNamespace.get(entry.namespace).push(entry)
  }
  const lineOf = entry => `- \`${entry.name}${entry.signature}\`: ${entry.description}`
  const available = entries.length === 0
    ? ['No tools are currently available in this session.']
    : [
        '<available_tools>',
        ...resident.map(lineOf),
        ...[...byNamespace.entries()].flatMap(([namespace, group]) => [
          `- namespace \`${namespace}\` (activated):`,
          ...group.map(entry => `  ${lineOf(entry)}`),
        ]),
        '</available_tools>',
      ]
  const footer = inactive.length === 0
    ? 'This is the complete current list and replaces any earlier available-tools list in this session.'
    : 'This is the current on-wire list and replaces any earlier available-tools list in this session.'
  // The paged-out summary states its own reachability per presentation, because
  // the presentations differ on exactly the fact a reader would otherwise have
  // to infer from the program contract further down: 'ptc' pages the whole
  // surface, and 'native' carries no program at all.
  const inactiveReachability = presentation === 'ptc'
    ? 'The page covers the whole surface here, not the wire alone: these namespaces are unreachable from inside a program too until they are activated.'
    : 'This presentation carries no program transport, so the wire is the only surface these namespaces can be reached through.'
  const inactiveBlock = inactive.length === 0 ? [] : [
    '',
    'These tool namespaces are registered but currently paged out of the wire:',
    inactiveReachability,
    '<inactive_namespaces>',
    ...inactive.map(ns => `- \`${ns.namespace}\` (${ns.count} tool${ns.count === 1 ? '' : 's'}${ns.sample === '' ? '' : `, e.g. \`${ns.sample}\``}): ${ns.description} Call \`tool_activate({ namespace: "${ns.namespace}" })\` to activate it.`),
    '</inactive_namespaces>',
  ]
  const presentationLines = presentation === 'ptc'
    ? ['', ...PTC_PROGRAM_LINES]
    : []
  return [
    '<system-reminder>',
    'The following tools are available in this session:',
    '',
    ...available,
    '',
    footer,
    ...inactiveBlock,
    ...presentationLines,
    '</system-reminder>',
  ].join('\n')
}

/** Build one durable user-role catalog message. */
export function createCatalogMessage(entries, presentation = 'native', inactive = []) {
  return {
    id: globalThis.crypto.randomUUID(), role: 'user',
    content: [{ type: 'text', text: renderCatalogText(entries, presentation, inactive) }],
    source: { kind: name },
  }
}

function textOf(message) {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
}

/** Register paging before step admission and inject the observed admitted catalog. */
export function apply(ctx, config = {}) {
  const descriptionMaxLength = integerAtLeast(name, config.descriptionMaxLength, 'descriptionMaxLength', 1, 200)
  const patterns = validatePagedToolPatterns(name, config.pagedToolPatterns)
  const capacity = integerAtLeast(name, config.maxActiveNamespaces, 'maxActiveNamespaces', 1, 3)
  const budget = integerAtLeast(name, config.maxResidentTokens, 'maxResidentTokens', 1, 8000)
  const paging = new Map()
  const catalogs = new WeakMap()
  const agentBySession = new WeakMap()
  const pagingErrors = new WeakMap()
  const warned = new WeakSet()

  const release = (agent) => {
    const previous = paging.get(agent)
    paging.delete(agent)
    previous?.dispose()
  }
  const sync = (agent) => {
    release(agent)
    const full = ctx.tools.schemas(agent)
    const active = replayActivations(agent.session.snapshotEvents(), capacity, patterns).active
    const { inactive } = partitionWireTools(full, patterns, active)
    const deny = [...inactive.values()].flatMap(tools => tools.map(tool => tool.name))
    try {
      const dispose = deny.length === 0 ? () => {} : agent.ctx.tools.restrict({ deny })
      paging.set(agent, { inactive, dispose })
      pagingErrors.delete(agent)
    } catch (cause) {
      const error = new Error(`${name}: namespace paging requires inherited tools; move matching Agent-local registrations to the Host or preset scope`, { cause })
      pagingErrors.set(agent, error)
      throw error
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    agentBySession.set(agent.session, agent)
    sync(agent)
  })
  // Inbox claiming precedes admission; step/end also covers tool-only continuations.
  ctx.on('agent/inbox/claimed', ({ agent }) => sync(agent))
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'step/end') return
    const agent = agentBySession.get(session)
    if (agent !== undefined) sync(agent)
  })
  ctx.on('agent/disposed', ({ agent }) => {
    release(agent)
    catalogs.delete(agent)
  })
  ctx.effect(() => () => {
    for (const agent of [...paging.keys()]) release(agent)
  }, 'liangshen.catalog.paging')

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.scope
    if (agent?.session === undefined) return assembled
    const pagingError = pagingErrors.get(agent)
    if (pagingError !== undefined) throw pagingError
    const surface = ctx.tools.schemas(agent, context.toolSet)
    const presentation = assembled.sections.some(section => section.name === 'tools:ptc-only' && section.text !== '')
      ? 'ptc' : 'native'
    const entries = catalogEntries(surface, descriptionMaxLength, { patterns })
    const inactive = summarizeInactive(paging.get(agent)?.inactive, value => catalogDescription(value, descriptionMaxLength))
    catalogs.set(agent, { entries, presentation, inactive })
    const estimated = estimateSurfaceTokens(surface)
    if (estimated > budget && !warned.has(agent)) {
      warned.add(agent)
      ctx.logger.warn(`${name}: admitted tool schemas are approximately ${estimated} tokens, exceeding maxResidentTokens=${budget}; configure pagedToolPatterns to defer additional namespaces`)
    }
    return assembled
  }, { prepend: true })

  ctx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter') return decision
    const state = catalogs.get(agent)
    if (state === undefined) return decision
    const { entries, presentation, inactive } = state
    const candidate = renderCatalogText(entries, presentation, inactive)
    const visible = agent.session.deriveMessages().filter(message => message.source.kind === name).at(-1)
    const existing = decision.messages.find(message => message.source.kind === name)
    if (visible !== undefined && textOf(visible) === candidate) {
      return existing === undefined ? decision : { ...decision, messages: decision.messages.filter(message => message !== existing) }
    }
    if (existing !== undefined && textOf(existing) === candidate) return decision
    if (visible === undefined && entries.length === 0 && inactive.length === 0) return decision
    const catalog = createCatalogMessage(entries, presentation, inactive)
    return {
      ...decision,
      messages: existing === undefined ? [...decision.messages, catalog]
        : decision.messages.map(message => message === existing ? catalog : message),
    }
  }, { prepend: true })
}
