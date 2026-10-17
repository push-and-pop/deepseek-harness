/**
 * The `Name: value` text form of a request-header dictionary. One format
 * serves both settings surfaces: a card stages it as a single field, and the
 * model provider editor parses the same lines into its draft.
 */

/** One header line, as the text form spells it. */
const LINE = /^([^:\r\n]+):[ \t]*(.*)$/u

/**
 * Render a stored header dictionary as one `Name: value` line per entry.
 * Entries whose value is not a string are left out: the text form only
 * carries what it can restore.
 * @param value - stored dictionary, or anything a descriptor may hold.
 * @returns the lines, empty when the value carries no string entry.
 */
export function formatHeaderLines(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return ''
  return Object.entries(value)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    .map(([name, headerValue]) => `${name}: ${headerValue}`)
    .join('\n')
}

/**
 * Parse one `Name: value` header per line. Blank lines are ignored; a line
 * without a name or colon, or a name or value Fetch cannot put on a request,
 * rejects the whole draft. Names collide case-insensitively and the last
 * line wins, matching how a header dictionary would read on the wire.
 * @param text - the drafted lines.
 * @returns the header dictionary, or undefined when a line is not one.
 */
export function parseHeaderLines(text: string): Record<string, string> | undefined {
  const entries = new Map<string, [string, string]>()
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim() === '') continue
    const match = LINE.exec(line.trim())
    if (match === null) return undefined
    const name = (match[1] ?? '').trim()
    const value = (match[2] ?? '').trim()
    if (name === '') return undefined
    try {
      new Headers([[name, value]])
    } catch {
      return undefined
    }
    entries.set(name.toLowerCase(), [name, value])
  }
  return Object.fromEntries(entries.values())
}
