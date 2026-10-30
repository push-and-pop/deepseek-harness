/** Localized copy for shipped presets and declared copy for every other row. */

import { describe, expect, it } from 'vitest'
import { de, en, es, fr, ja, presetDisplayText, pt, ru, zh } from '../src/client/locales.ts'

const translate = (bundle: typeof en) => (key: keyof typeof en): string => bundle[key]

const locales = [
  ['English', en], ['Chinese', zh], ['Japanese', ja], ['Spanish', es],
  ['French', fr], ['German', de], ['Russian', ru], ['Portuguese', pt],
] as const

describe.each(locales)('preset display copy in %s', (_locale, bundle) => {
  it.each([
    ['standard', 'presetStandardName', 'presetStandardDescription'],
    ['ptc', 'presetPtcName', 'presetPtcDescription'],
    ['minimal', 'presetMinimalName', 'presetMinimalDescription'],
    ['cordis', 'presetCordisName', 'presetCordisDescription'],
    ['liangshen', 'presetLiangshenName', 'presetLiangshenDescription'],
  ] as const)('localizes the shipped %s preset', (id, nameKey, descriptionKey) => {
    expect(bundle[nameKey].length).toBeGreaterThan(0)
    expect(bundle[descriptionKey].length).toBeGreaterThan(0)
    expect(presetDisplayText({ id }, translate(bundle)))
      .toEqual({ name: bundle[nameKey], description: bundle[descriptionKey] })
  })

  it('keeps declared metadata untranslated for named and unknown presets', () => {
    const fileCopy = { name: '我的标准', description: '团队自己的 preset。' }

    for (const id of ['standard', 'liangshen', 'deployment-extra']) {
      expect(presetDisplayText({ id, ...fileCopy }, translate(bundle)))
        .toEqual(fileCopy)
    }
    expect(presetDisplayText({ id: 'bare' }, translate(bundle)))
      .toEqual({ name: 'bare' })
  })
})

describe('Deep mode display wording', () => {
  it('describes its mechanisms in English and Chinese', () => {
    expect(presetDisplayText({ id: 'liangshen' }, translate(en))).toEqual({
      name: 'Deep mode',
      description: 'Uses minimal prompts, PTC batching, on-demand tool loading, and key facts for context.',
    })
    expect(presetDisplayText({ id: 'liangshen' }, translate(zh))).toEqual({
      name: 'Deep模式',
      description: '使用极简提示词、PTC 批处理和按需加载工具，以关键事实组织上下文。',
    })
  })
})
