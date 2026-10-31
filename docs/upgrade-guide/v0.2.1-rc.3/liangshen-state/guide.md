---
kind: upgrade-guide
description: Custom Deep presets need the isolated shared state row and must move paging options to its configuration.
---

# Deep preset state and dispatcher configuration

English | [中文](guide.zh.md)

## Change

The built-in `liangshen` preset uses an isolated `liangshen-runtime` group containing `liangshen-state`, the tool catalog, activation tool, fact register, and working context. The consumers require the shared state service. Native and PTC settlements update one incremental projection; Session logs retain their existing format.

`pagedToolPatterns` and `maxActiveNamespaces` move from the catalog/activation/context rows to `liangshen-state.config`. Fact limits are configured there too. The dispatcher defaults to compact guidance; `dispatcherDetail: full` selects the original full rules, and `dispatcher: false` still disables dispatcher text. Standard remains unchanged.

## Migration

1. If you have no custom Deep preset override, start a new task after upgrading; existing tasks retain their selected preset revision.
2. For an overridden `preset-liangshen`, update its complete `config.plugins` from the [shipped declaration](../../../../packages/bundle/web-app/presets/liangshen.patch.yml). Keep the shared state row and its four consumers together under `isolate: { liangshenState: true }`.
3. Move paging options to `liangshen-state.config`. Set fact bounds there; configure `maxContextChars` and `refreshAfterSteps` on `working-context`. Choose `dispatcherDetail: full` only if you need the original dispatcher rules.
4. `maxResidentTokens` is an estimate for serialized capability schemas, not a model-token or complete-request limit. The default `budgetMode: warn` preserves admission. Opt into `enforce` to withhold complete oldest namespaces and reject a resident-only excess.
5. Confirm the preset is not marked broken, then start a new Deep task. Verify a successful `run_code` activation enables its namespace on the next request and a registered fact appears in working context. Do not expect old sessions or an unrepackaged Desktop application to adopt source edits automatically.
