---
kind: upgrade-guide
description: 自定义 Deep 预设需增加隔离的共享状态行，并将分页选项迁移到该行配置。
---

# Deep 预设状态与调度配置

[English](guide.md) | 中文

## 变更

内置 `liangshen` 预设通过隔离的 `liangshen-runtime` 分组装载 `liangshen-state`、工具目录、激活工具、事实登记和 working context。各消费者必须使用共享状态服务；原生与 PTC 成功调用统一更新增量投影，Session 日志格式不变。

`pagedToolPatterns` 与 `maxActiveNamespaces` 从目录、激活和上下文行迁移至 `liangshen-state.config`，事实上限也在该处配置。调度提示默认精简；`dispatcherDetail: full` 选择原完整规则，`dispatcher: false` 仍关闭调度文本。标准模式不变。

## 迁移

1. 未自定义 Deep 预设时，升级后新建任务即可；已有任务保留此前选择的预设修订。
2. 覆盖过 `preset-liangshen` 时，参照[随包声明](../../../../packages/bundle/web-app/presets/liangshen.patch.yml)更新完整的 `config.plugins`。共享状态行及四个消费者必须同处 `isolate: { liangshenState: true }` 分组。
3. 将分页选项移至 `liangshen-state.config`，并在该处设置事实上限；在 `working-context` 配置 `maxContextChars` 和 `refreshAfterSteps`。仅在需要原完整调度规则时设置 `dispatcherDetail: full`。
4. `maxResidentTokens` 估算工具能力 schema 序列化后的大小，不是实际模型词元数或完整请求上限。默认 `budgetMode: warn` 不改变准入；显式启用 `enforce` 后会隐藏整个最旧命名空间，常驻工具本身超限时拒绝准入。
5. 确认预设未标记为损坏，再新建 Deep 任务，验证 `run_code` 中成功激活的命名空间在下一次请求可用、登记的事实出现在 working context 中。已有会话或尚未重新打包的桌面应用不会自动采用源码修改。
