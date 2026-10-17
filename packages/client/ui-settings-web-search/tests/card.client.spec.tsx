// @vitest-environment jsdom
/** The web-search page as the Plugins page renders it: its key control, its two fields, and their resets. */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFieldState, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'
import { WebSearchCard, type WebSearchCardProps } from '../src/client/WebSearchCard.tsx'
import { WebFetchCard, type WebFetchCardProps } from '../src/client/WebFetchCard.tsx'
import type { WebSearchCardState } from '../src/client/web-search-card-controller.ts'
import type { WebFetchCardState } from '../src/client/web-fetch-card-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

const settled: SettingsFormShell = { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false }

function field(text: string, rest: Partial<SettingsFieldState> = {}): SettingsFieldState {
  return { text, overridden: false, invalid: false, ...rest }
}

function cardActions() {
  return { edit: vi.fn(), resetField: vi.fn(), save: vi.fn(), discard: vi.fn() }
}

describe('WebSearchCard', () => {
  function renderWebSearch(state: Partial<WebSearchCardState> = {}) {
    const store = createSnapshotStore<WebSearchCardState>({
      ...settled,
      baseURL: field(''),
      maxUses: field('5'),
      userAgent: field(''),
      headers: field(''),
      apiKey: field(''),
      apiKeyConfigured: false,
      apiKeyWritable: true,
      ...state,
    })
    const actions = cardActions()
    const props = { ...actions, view: 'page', t, useWebSearchCard: bindSnapshotSelector(store) } as WebSearchCardProps
    render(<WebSearchCard {...props} />)
    return actions
  }

  it('renders its one-liner alone in the summary view', () => {
    const store = createSnapshotStore<WebSearchCardState>({
      ...settled, baseURL: field(''), maxUses: field('5'), userAgent: field(''), headers: field(''), apiKey: field(''), apiKeyConfigured: false, apiKeyWritable: true,
    })
    const props = { ...cardActions(), view: 'summary', t, useWebSearchCard: bindSnapshotSelector(store) } as WebSearchCardProps
    render(<WebSearchCard {...props} />)

    expect(document.body.textContent).toBe(en.description)
    expect(screen.queryByLabelText(en.apiKey)).toBeNull()
  })

  it('reports whether a key is configured without ever showing one', () => {
    renderWebSearch({ apiKeyConfigured: true })

    expect(screen.getByText(en.apiKeySet)).toBeTruthy()
    expect(screen.getByLabelText(en.apiKey)).toHaveProperty('type', 'password')
  })

  it('keeps the key control usable while the settings document is read-only', () => {
    const actions = renderWebSearch({ writable: false })

    const key = screen.getByLabelText(en.apiKey)
    expect(key).toHaveProperty('disabled', false)
    expect(screen.getByLabelText(en.baseUrl)).toHaveProperty('disabled', true)

    fireEvent.change(key, { target: { value: 'ds-secret' } })

    expect(actions.edit).toHaveBeenCalledWith('apiKey', 'ds-secret')
  })

  it('disables the key control when the reference itself is not writable', () => {
    // A key coming from the process environment: the settings document is
    // writable, the credential is not.
    renderWebSearch({ apiKeyConfigured: true, apiKeyWritable: false })

    expect(screen.getByLabelText(en.apiKey)).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.baseUrl)).toHaveProperty('disabled', false)
  })

  it('stages the endpoint, the search budget, the agent, the headers, and their resets', () => {
    const actions = renderWebSearch({
      baseURL: field('https://search.test/v1', { overridden: true }),
      maxUses: field('3', { overridden: true }),
      userAgent: field('search-agent/1.0', { overridden: true }),
      headers: field('X-Tenant: acme', { overridden: true }),
    })

    fireEvent.change(screen.getByLabelText(en.baseUrl), { target: { value: 'https://other.test' } })
    fireEvent.change(screen.getByLabelText(en.maxUses), { target: { value: '4' } })
    fireEvent.change(screen.getByLabelText(en.userAgent), { target: { value: 'search-agent/2.0' } })
    fireEvent.change(screen.getByLabelText(en.headers), { target: { value: 'X-Tenant: beta' } })
    const resets = screen.getAllByRole('button', { name: en.reset })
    expect(resets).toHaveLength(4)
    for (const reset of resets) fireEvent.click(reset)

    expect(actions.edit.mock.calls).toEqual([
      ['baseURL', 'https://other.test'],
      ['maxUses', '4'],
      ['userAgent', 'search-agent/2.0'],
      ['headers', 'X-Tenant: beta'],
    ])
    expect(actions.resetField.mock.calls).toEqual([['baseURL'], ['maxUses'], ['userAgent'], ['headers']])
  })
})

describe('WebFetchCard', () => {
  function renderWebFetch(state: Partial<WebFetchCardState> = {}) {
    const store = createSnapshotStore<WebFetchCardState>({
      ...settled,
      userAgent: field(''),
      ...state,
    })
    const actions = cardActions()
    const props = { ...actions, view: 'page', t, useWebFetchCard: bindSnapshotSelector(store) } as WebFetchCardProps
    render(<WebFetchCard {...props} />)
    return actions
  }

  it('renders its one-liner alone in the summary view', () => {
    const store = createSnapshotStore<WebFetchCardState>({ ...settled, userAgent: field('') })
    const props = { ...cardActions(), view: 'summary', t, useWebFetchCard: bindSnapshotSelector(store) } as WebFetchCardProps
    render(<WebFetchCard {...props} />)

    expect(document.body.textContent).toBe(en.fetchDescription)
    expect(screen.queryByLabelText(en.userAgent)).toBeNull()
  })

  it('stages the agent and its reset, disabled while the document is read-only', () => {
    const actions = renderWebFetch({ userAgent: field('fetch-agent/1.0', { overridden: true }) })

    const agent = screen.getByLabelText(en.userAgent)
    expect(agent).toHaveProperty('value', 'fetch-agent/1.0')
    fireEvent.change(agent, { target: { value: 'fetch-agent/2.0' } })
    expect(actions.edit).toHaveBeenCalledWith('userAgent', 'fetch-agent/2.0')
    fireEvent.click(screen.getByRole('button', { name: en.reset }))
    expect(actions.resetField).toHaveBeenCalledWith('userAgent')
  })

  it('disables the agent while the settings document is read-only', () => {
    renderWebFetch({ writable: false })

    expect(screen.getByLabelText(en.userAgent)).toHaveProperty('disabled', true)
  })
})
