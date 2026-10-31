/** Local management responses; the login URL is secret and must not be persisted or logged. */
export interface TailscaleStatus {
  readonly state: 'not-installed' | 'needs-login' | 'offline' | 'ready' | 'running' | 'error'
  readonly dnsName?: string
  readonly url?: string
  readonly code?: string
  readonly error?: string
}

/** Validated plugin deployment choices. */
export interface TailscaleConfig {
  /** Local CLI absolute path, or the bare name tailscale resolved from system paths. */
  readonly executable: string
  /** Private HTTPS listener port; existing Serve or Funnel listeners are never replaced. */
  readonly httpsPort: number
  /** Maximum time for a CLI probe or complete listener startup, in milliseconds. */
  readonly commandTimeoutMs: number
  /** Grace after termination before killing the owned CLI, in milliseconds. */
  readonly shutdownGraceMs: number
  /** Delay between foreground proxy readiness probes, in milliseconds. */
  readonly readinessPollMs: number
}
