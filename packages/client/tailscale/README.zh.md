---
description: "通过手动开启的 Tailscale 连接在手机上访问 DSH，仅允许本机管理，不开放公网监听。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-tailscale

[English](README.md) | 中文

## 概述

在电脑上打开**设置 → 手机远程访问**，即可通过 Tailscale 在手机上使用 DSH，无需公网 IP 或自有域名。请先在两台设备上安装并登录 Tailscale，挂载本包不会自动开启远程访问。连接仅在 DSH 和此插件持续运行时有效。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办工作](#known-limitations-and-deferred-work)
- [开发笔记](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

Bundle 补丁挂载 `tailscale` 这一行，不会自动建立连接。同一个包提供本机管理路由和**手机远程访问**设置页。

在电脑和 iPhone 上安装 Tailscale，并登录同一个私有网络。在 [Tailscale DNS 控制台](https://login.tailscale.com/admin/dns)启用 MagicDNS 和 HTTPS；设备名称可能出现在公开证书透明日志中。在电脑上刷新状态，然后手动开启远程访问。保持两台设备均已连接 Tailscale，用 iPhone 相机扫描页面显示的二维码，再用 Safari 打开链接；仍保留复制链接作为备用方式。

二维码和复制的链接包含相同的 DSH 登录令牌，请勿分享或截图外传，仅供自己的设备使用；能够访问 DSH 的其他持有者可能使用其权限。页面不会记录链接日志，也不会将其保存在浏览器存储中。关闭访问会停止本插件的代理，不会撤销登录令牌。远程浏览器不能读取链接或管理连接。

### 重启后保持链接一致

二维码和复制链接使用 `/tailscale/connect?token=...`。独立的 256 位秘密通过 Host 凭据提供方保存在 `tailscale-link/profile-<sha256(配置名称)>`，浏览器令牌绑定到精确 HTTPS 来源。只要 DSH 数据目录、配置名称、Tailscale 设备名称及 HTTPS 端口不变，DSH 重启后完整链接保持一致，即使本机回环端口发生变化。普通 DSH 进程启动令牌仍会轮换，不会出现在这个固定链接中。

只有本插件已开启私有访问时，固定链接才能交换得到正常的 Secure、HttpOnly 浏览器 cookie。错误主机、跨站请求、缺少或被篡改的令牌以及已关闭的访问均会被拒绝。固定链接是长期登录凭据，并非公开网址。链接泄露时应先关闭远程访问；删除本配置对应的 `tailscale-link` 凭据记录并重启可生成新链接，但不会撤销已有浏览器 cookie。从旧版临时链接首次升级时需要重新扫码一次。重启后访问开关仍默认关闭，重新开启后即可沿用原链接。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `executable` | `tailscale` | 本机 Tailscale CLI 名称或绝对路径。 |
| `httpsPort` | `8443` | 私有 HTTPS 端口，不会覆盖已有监听。 |
| `commandTimeoutMs` | `15000` | CLI 命令和就绪检查的截止时长，单位为毫秒。 |
| `shutdownGraceMs` | `3000` | 前台进程优雅停止的截止时长，单位为毫秒。 |
| `readinessPollMs` | `250` | 私有监听就绪检查的间隔，单位为毫秒。 |

未安装、需要登录、设备离线、端口占用或请求失败时，页面会显示恢复指引。操作结果无法确认时，请先刷新再重试；界面不会将响应丢失等同于操作失败。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

[补丁](cordis.patch.yml)添加包的根插件行，使 Client Modules 能发现其浏览器半部。Host 拥有前台 Serve 进程及其受信任来源，管理路由仅接受经过认证的本机所有者请求。卸载 Host 插件会停止其进程；卸载浏览器半部会中止读取并清除秘密链接状态，不改变 Host 连接。

浏览器注册 `settings.section` 和由应用壳承载的通知入口。私有内存快照向页面提供状态和窄回调。读取不会建立隧道；开启和关闭是显式用户操作，不提供 Agent 工具。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Connection](../connection/README.zh.md)——认证通信与来源信任。
- [Settings](../ui-settings/README.zh.md)——设置页面组合。
- [Web Client 架构](../../../docs/subsystems/web-client.zh.md)——Host 与浏览器的职责。

-----

<a id="model-experience"></a>
## 模型体验

### 模型请求内容

#### 模型所见

模型不会看到本插件的内容。插件仅提供 `settings.section` 界面和经过认证的 `/tailscale/*` 路由，不添加模型工具、提示词章节或 Session 事件。

#### Token 影响

不增加请求词元。

#### KV Cache 影响

本包不添加模型请求内容，也不改变请求前缀。

## 已知限制与待办工作

<a id="known-limitations-and-deferred-work"></a>

- 必须预先安装支持前台 Serve 的 Tailscale，电脑必须保持唤醒并联网。仅可共享本机回环 HTTP DSH 监听；所选端口开启 Funnel 时会拒绝连接。不会重置或替换现有 Tailscale 监听。

- 开启状态不会持久化。退出 DSH 或卸载插件会停止远程访问，重新打开 DSH 后需再次开启。二维码在浏览器本地生成，不向第三方二维码服务发送链接；刷新、关闭、状态失败或远程访问页面时会隐藏二维码，但不额外改变令牌过期机制。真机连接及在独立 Profile 中安装仍需手动验证。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

本包的模拟 CLI 和组件测试不能验证真实电脑到 iPhone 的连接，也不能验证浅色与深色主题下的渲染布局。

</details>
