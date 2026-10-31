/** Normalize committed native and PTC tool settlements for Deep's state reducers. */

function argumentsOf(value) {
  if (typeof value !== 'string') return value
  try { return JSON.parse(value) } catch (error) {
    // Historical malformed calls cannot contribute a successful state change.
    if (error instanceof SyntaxError) return undefined
    throw error
  }
}

/**
 * Advance pending native calls and return at most one successful settlement.
 * @param pending - JSON dictionary of relevant calls awaiting their results.
 * @param event - one committed Session event, in log order.
 * @param accept - select tool names before retaining their arguments.
 * @returns the pending dictionary and, when successful, the settled call.
 */
export function settleEvent(pending, event, accept = () => true) {
  const data = event.data
  if (event.type === 'turn/end') {
    return { pending: Object.keys(pending).length === 0 ? pending : {} }
  }
  if (event.type === 'tool/call') {
    if (!accept(data.name)) return { pending }
    return { pending: { ...pending, [data.callId]: { name: data.name, arguments: argumentsOf(data.arguments) ?? null } } }
  }
  if (event.type === 'tool/result') {
    const id = data.message.source.callId
    if (!Object.hasOwn(pending, id)) return { pending }
    const call = pending[id]
    const remaining = { ...pending }
    delete remaining[id]
    if (data.error !== undefined || data.message.isError === true) return { pending: remaining }
    return { pending: remaining, call: { id, ...call } }
  }
  if (event.type === 'tool/ptc-dispatch' && accept(data.name) && !data.isError && data.error === undefined) {
    return { pending, call: { id: data.subCallId, name: data.name, arguments: data.arguments } }
  }
  return { pending }
}
