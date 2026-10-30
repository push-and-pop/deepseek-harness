/**
 * Display resolution: shipped presets resolve through dictionary keys, and
 * user-authored metadata is never translated.
 */

import { describe, expect, it } from 'vitest'
import { isBuiltInPreset, presetDisplayText, type BuiltInPresetCopyKey } from '../src/display.ts'

const t = (key: BuiltInPresetCopyKey): string => `t:${key}`

describe('presetDisplayText', () => {
  it('resolves a shipped preset through its dictionary keys', () => {
    expect(presetDisplayText({ id: 'standard' }, t)).toEqual({
      name: 't:presetStandardName',
      description: 't:presetStandardDescription',
    })
  })

  it('recognizes Liangshen and resolves its dictionary keys', () => {
    const preset = { id: 'liangshen' }
    expect(isBuiltInPreset(preset)).toBe(true)
    expect(presetDisplayText(preset, t)).toEqual({
      name: 't:presetLiangshenName',
      description: 't:presetLiangshenDescription',
    })
  })

  it('keeps named Liangshen declarations untranslated', () => {
    const preset = { id: 'liangshen', name: 'Team mode', description: 'Team copy' }
    expect(isBuiltInPreset(preset)).toBe(false)
    expect(presetDisplayText(preset, t)).toEqual({ name: 'Team mode', description: 'Team copy' })
  })

  it('keeps user-authored metadata untranslated', () => {
    expect(presetDisplayText({ id: 'mine', name: '我的模式', description: '自述' }, t))
      .toEqual({ name: '我的模式', description: '自述' })
  })

  it('falls back to the id for a preset publishing no metadata', () => {
    // A system id outside the shipped set behaves like authored metadata:
    // there is no dictionary copy to resolve.
    expect(presetDisplayText({ id: 'future' }, t)).toEqual({ name: 'future' })
    expect(presetDisplayText({ id: 'bare' }, t)).toEqual({ name: 'bare' })
  })
})
