---
description: "Private phone access to DSH through a manually enabled Tailscale connection, with local-only management and no public listener."
kind: "package-bundle"
---

# @deepseek-ai/dsh-client-tailscale

English | [中文](README.zh.md)

## Summary

Use **Settings → Remote access** on your PC to connect your phone to DSH through Tailscale. You do not need a public IP address or your own domain. Install and sign in to Tailscale on both devices first; mounting this package never enables remote access automatically. The connection lasts only while DSH and this plugin remain running.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The bundle patch mounts one row, `tailscale`, with no automatic connection. The same package supplies both the local management routes and the **Remote access** settings page.

Install Tailscale on the PC and iPhone and sign in to the same private network. Enable MagicDNS and HTTPS in the [Tailscale DNS console](https://login.tailscale.com/admin/dns); the device name may appear in public certificate transparency logs. On the PC, refresh the status and explicitly enable remote access. Scan the displayed QR code with the iPhone camera and open the link in Safari while Tailscale is connected on both devices. Copy phone link remains available as a fallback.

The QR code and copied link contain the same DSH sign-in token; do not share or screenshot them. Share it only with your own device; another holder who can reach DSH may use its permissions. The page never logs or stores the link in browser storage. Disabling access stops this plugin's proxy, not the sign-in token. Remote browsers cannot read links or manage the connection.

### Stable links across restarts

The QR code and copied URL use `/tailscale/connect?token=...`. A separate 256-bit secret is stored through the Host credential provider under `tailscale-link/profile-<sha256(profile name)>`; the browser token is derived for the exact HTTPS origin. With the same Harness home, profile, Tailscale device name, and HTTPS port, the complete link is unchanged after restarting DSH, even when its loopback port changes. The ordinary DSH process launch token still rotates and is never included in this persistent link.

A valid stable link exchanges for the normal Secure, HttpOnly browser cookie only while this plugin has an active private origin. Wrong hosts, cross-site requests, missing or modified tokens, and disabled access are refused. The link is a long-lived login credential, not a public address. Stop remote access before revoking a leaked link; removing this profile's `tailscale-link` credential record and restarting creates a new link, without revoking existing browser cookies. The first upgrade from process-token links requires one new scan. The access switch still defaults to off after restart; enable it again to reuse the saved link.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `executable` | `tailscale` | Local Tailscale CLI name or absolute path. |
| `httpsPort` | `8443` | Private HTTPS port; existing listeners are not overwritten. |
| `commandTimeoutMs` | `15000` | CLI command and readiness deadline in milliseconds. |
| `shutdownGraceMs` | `3000` | Graceful foreground-process shutdown deadline in milliseconds. |
| `readinessPollMs` | `250` | Interval between private listener readiness checks in milliseconds. |

A missing installation, sign-in requirement, disconnected device, occupied port, or failed request appears with a recovery action. After an unconfirmed operation, refresh before retrying; the UI does not assume that a lost response means the operation failed.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [patch](cordis.patch.yml) adds the package's root row so Client Modules can discover its browser half. The Host owns the foreground Serve process and its trusted origin. Local authenticated owner requests are the only callers admitted to the management routes. Unloading the Host plugin stops its process; unloading the browser half aborts reads and clears secret link state without changing the Host connection.

The browser registers `settings.section` and a shell-owned notification host. A private in-memory snapshot supplies status and narrow callbacks to the page. Reads do not create a tunnel; enable and disable are explicit user actions and have no agent tool.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Connection](../connection/README.md) — authenticated carrier and origin trust.
- [Settings](../ui-settings/README.md) — settings composition.
- [Web client architecture](../../../docs/subsystems/web-client.md) — Host and browser ownership.

-----

<a id="model-experience"></a>
## Model Experience

### Model request content

#### What the model sees

Nothing from this plugin. It exposes only the `settings.section` UI and authenticated `/tailscale/*` routes, with no model-facing tools, prompt sections, or Session events.

#### Token effect

Zero additional request tokens.

#### KV Cache effect

The package adds no model request content and does not change the request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Tailscale must already be installed and support foreground Serve. The PC must stay awake and connected. Only a loopback HTTP DSH listener can be shared, and Funnel on the selected port is refused. Existing Tailscale listeners are not reset or replaced.

- Enabled state is not persisted. Exiting DSH or unloading the plugin stops remote access; reopening DSH requires enabling it again. QR encoding runs locally in the browser; no link is sent to a third-party QR service. Refresh, stop, failed status, and remote-only access hide the code without adding a new token-expiry mechanism. Real-device connectivity and installation into a separate profile require manual verification.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

A live PC-to-iPhone connection and rendered light/dark layouts are not verified by the package's mocked CLI and component tests.

</details>
