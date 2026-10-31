/** Local-only Tailscale commands: argv execution, minimal environment, bounded output, awaited shutdown. */
import { spawn } from 'node:child_process'
import { access } from 'node:fs/promises'
import { join, isAbsolute } from 'node:path'
import { TailscaleError, type TailscaleConfig } from './protocol.ts'

/** Owned foreground CLI process. No output is published to logs or spill files. */
export interface ServeProcess {
  readonly done: Promise<void>
  stop(): Promise<void>
}

/** Native command operations supplied by the Host or deterministic tests. */
export interface TailscaleDriver {
  readonly resolve: () => Promise<string | undefined>
  readonly run: (executable: string, args: readonly string[], signal: AbortSignal) => Promise<string>
  readonly serve: (executable: string, args: readonly string[]) => ServeProcess
}

const MAX_OUTPUT_BYTES = 1024 * 1024
const SYSTEM_ENV_KEYS = new Set([
  'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'USERPROFILE',
  'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)',
  'LANG', 'LC_ALL',
])

/** Give the native CLI only system paths and locale, never Harness credentials.
 * @param source Parent environment.
 * @returns Explicit allowlisted child environment.
 */
export function nativeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && SYSTEM_ENV_KEYS.has(key.toUpperCase())))
}

/** Create the real local CLI driver.
 * @param config Validated deployment choices.
 * @returns Driver bound to a minimal system environment.
 */
export function createNativeDriver(config: TailscaleConfig): TailscaleDriver {
  const env = nativeEnvironment(process.env)
  const exists = async (file: string): Promise<boolean> => {
    try { await access(file); return true }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return false
      throw new TailscaleError('command-failed', { cause: error })
    }
  }
  return {
    resolve: async () => {
      const executable = config.executable
      if (isAbsolute(executable)) return await exists(executable) ? executable : undefined
      if (executable !== 'tailscale') throw new TailscaleError('invalid-executable')
      const path = Object.entries(env).find(([key]) => key.toUpperCase() === 'PATH')?.[1] ?? ''
      const name = process.platform === 'win32' ? 'tailscale.exe' : 'tailscale'
      const candidates = path.split(process.platform === 'win32' ? ';' : ':').filter(isAbsolute).map(dir => join(dir, name))
      if (process.platform === 'win32') {
        const programFiles = Object.entries(env).find(([key]) => key.toUpperCase() === 'PROGRAMFILES')?.[1]
        if (programFiles !== undefined) candidates.push(join(programFiles, 'Tailscale', name))
      }
      for (const candidate of candidates) if (await exists(candidate)) return candidate
      return undefined
    },
    run: (executable, args, signal) => new Promise((resolve, reject) => {
      const child = spawn(executable, [...args], { env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      let bytes = 0
      let failure: Error | undefined
      let escalation: ReturnType<typeof setTimeout> | undefined
      const stop = (): void => {
        child.kill()
        escalation ??= setTimeout(() => { child.kill('SIGKILL') }, config.shutdownGraceMs)
      }
      const abort = (): void => { failure = new TailscaleError('command-timeout'); stop() }
      child.on('error', (error) => { failure = error })
      child.stdout.on('data', (chunk: Buffer) => {
        bytes += chunk.byteLength
        if (bytes > MAX_OUTPUT_BYTES) { failure = new TailscaleError('invalid-status'); stop() }
        else chunks.push(chunk)
      })
      // Consume diagnostics without retaining potentially sensitive CLI output.
      child.stderr.resume()
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      child.on('close', (code, exitSignal) => {
        signal.removeEventListener('abort', abort)
        clearTimeout(escalation)
        if (failure !== undefined) reject(failure)
        else if (code !== 0 || exitSignal !== null) reject(new TailscaleError('command-failed'))
        else resolve(Buffer.concat(chunks).toString('utf8'))
      })
    }),
    serve: (executable, args) => {
      const child = spawn(executable, [...args], { env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.resume()
      child.stderr.resume()
      let closed = false
      let escalation: ReturnType<typeof setTimeout> | undefined
      const done = new Promise<void>((resolve, reject) => {
        let failure: Error | undefined
        child.on('error', (error) => { failure = error })
        child.on('close', () => {
          closed = true
          clearTimeout(escalation)
          if (failure !== undefined) reject(new TailscaleError('serve-exited', { cause: failure }))
          else resolve()
        })
      })
      return {
        done,
        stop: async () => {
          if (!closed) {
            child.kill()
            escalation ??= setTimeout(() => { child.kill('SIGKILL') }, config.shutdownGraceMs)
          }
          // Spawn failure still settles the owned child; the controller's done observer reports it.
          await done.catch((error: unknown) => {
            if (!(error instanceof TailscaleError)) throw error
          })
        },
      }
    },
  }
}
