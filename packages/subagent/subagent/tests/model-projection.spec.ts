import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { subagentModelProjectionDefinition, type ModelRouteState } from '../src/projection.ts'

/** One `request/header` event carrying only the fields the projection folds. */
function headerEvent(
  seq: number,
  config: { provider: string; model: string; reasoningEffort?: string },
): SessionEvent {
  return {
    type: 'request/header',
    seq,
    time: seq * 100,
    data: { header: { config }, reason: 'initial' },
  } as unknown as SessionEvent
}

/** One non-header event the fold must pass through without touching state. */
function noiseEvent(seq: number, type: SessionEvent['type']): SessionEvent {
  return { type, seq, time: seq * 100, data: {} } as SessionEvent
}

function fold(events: SessionEvent[]) {
  let state: ModelRouteState = subagentModelProjectionDefinition.init()
  for (const item of events) state = subagentModelProjectionDefinition.apply(state, item)
  return subagentModelProjectionDefinition.wire.view(state)
}

describe('subagent model projection', () => {
  it('answers the serializable null sentinel before any request header', () => {
    expect(fold([
      noiseEvent(0, 'turn/start'),
      noiseEvent(1, 'subagent/descriptor'),
      noiseEvent(2, 'turn/end'),
    ])).toBeNull()
  })

  it('folds the concrete provider, model, and effective reasoning effort', () => {
    expect(fold([
      noiseEvent(0, 'turn/start'),
      headerEvent(1, { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' }),
    ])).toEqual({ provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' })
  })

  it('omits the effort field when the effective header carries none', () => {
    expect(fold([
      headerEvent(0, { provider: 'pi-ai', model: 'glm-4.7' }),
    ])).toEqual({ provider: 'pi-ai', model: 'glm-4.7' })
  })

  it('folds last-wins: a later header replaces the route and its effort', () => {
    expect(fold([
      headerEvent(0, { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' }),
      headerEvent(1, { provider: 'pi-ai', model: 'glm-4.7', reasoningEffort: 'low' }),
    ])).toEqual({ provider: 'pi-ai', model: 'glm-4.7', reasoningEffort: 'low' })
    expect(fold([
      headerEvent(0, { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'high' }),
      headerEvent(1, { provider: 'deepseek-account', model: 'deepseek-chat' }),
    ])).toEqual({ provider: 'deepseek-account', model: 'deepseek-chat' })
  })
})
