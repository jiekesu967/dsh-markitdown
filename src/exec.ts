/**
 * Subprocess plumbing for the external MarkItDown engines.
 *
 * Every launch goes through `execFile` with `shell: false`, so a filename or URL
 * that contains shell metacharacters is passed as one argv element and can never
 * become a command. Only real executables are accepted — `where`/`which`
 * resolution rejects `.cmd`/`.bat` shims, because running those would require a
 * shell and would hand the input back to command-line parsing.
 */
import { execFile } from 'node:child_process'

/** Raised when the configured executable does not exist. */
export class ExecutableNotFoundError extends Error {
  readonly executable: string

  constructor(executable: string) {
    super(`executable not found: ${executable}`)
    this.name = 'ExecutableNotFoundError'
    this.executable = executable
  }
}

/** One finished subprocess. */
export interface ProcessResult {
  /** Decoded standard output. */
  stdout: string
  /** Decoded standard error. */
  stderr: string
  /** Process exit status; `0` on success. */
  code: number
}

/** Options shared by every launch. */
export interface RunOptions {
  /** Caller cancellation; the child is killed when it aborts. */
  signal?: AbortSignal | undefined
  /** Cooperative deadline in milliseconds. */
  timeoutMs: number
  /** Output cap in bytes before the child is killed. */
  maxBuffer?: number
  /** Environment overrides merged over `process.env`. */
  env?: Record<string, string> | undefined
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024

/**
 * Run one executable and capture its output.
 * @param argv - executable plus arguments; never shell-interpreted.
 * @param options - deadline, cancellation, buffer cap, and environment.
 * @returns the finished process result.
 * @throws ExecutableNotFoundError when argv[0] does not exist.
 * @throws Error on cancellation, timeout, or a non-zero exit status.
 */
export async function run(argv: readonly string[], options: RunOptions): Promise<ProcessResult> {
  const executable = argv[0]
  if (executable === undefined || executable === '') throw new Error('run() requires an executable')

  return await new Promise<ProcessResult>((resolve, reject) => {
    execFile(
      executable,
      argv.slice(1),
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        env: options.env === undefined ? process.env : { ...process.env, ...options.env },
      },
      (error, stdout, stderr) => {
        const out = typeof stdout === 'string' ? stdout : String(stdout ?? '')
        const err = typeof stderr === 'string' ? stderr : String(stderr ?? '')
        if (error === null) {
          resolve({ stdout: out, stderr: err, code: 0 })
          return
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }
        const spawnCode = typeof failure.code === 'string' ? failure.code : undefined
        if (spawnCode === 'ENOENT') {
          reject(new ExecutableNotFoundError(executable))
          return
        }
        if (options.signal?.aborted === true || spawnCode === 'ABORT_ERR') {
          reject(new Error(`conversion cancelled while running ${executable}`))
          return
        }
        if (spawnCode === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          // Killed for producing more output than the capture buffer allows —
          // a different failure than the deadline below, and the fix differs.
          const cap = options.maxBuffer ?? DEFAULT_MAX_BUFFER
          reject(new Error(`${executable} produced more than the ${cap}-byte output capture limit and was terminated`))
          return
        }
        if (spawnCode !== undefined) {
          // A launch-level failure (EPERM under a restrictive sandbox, EACCES, …)
          // is not the program's exit status; naming the code keeps the probe log
          // honest instead of mislabelling a blocked launch as "not installed".
          reject(new Error(`cannot launch ${executable}: ${spawnCode}`))
          return
        }
        if (failure.killed === true || failure.signal != null) {
          reject(new Error(`${executable} exceeded the ${options.timeoutMs} ms deadline and was terminated`))
          return
        }
        const status = typeof failure.code === 'number' ? failure.code : 1
        const detail = err.trim() === '' ? out.trim() : err.trim()
        reject(new Error(`${executable} exited with status ${status}${detail === '' ? '' : `: ${truncate(detail, 2000)}`}`))
      },
    )
  })
}

/** Result of a PATH lookup: either a usable executable or the reason there is none. */
export type WhichResult = { path: string } | { reason: string }

/**
 * Resolve a command name to a real executable path.
 * @param name - command name without extension.
 * @param options - cancellation and deadline for the lookup itself.
 * @returns the absolute path, or the reason no usable executable was found.
 */
export async function which(name: string, options: RunOptions): Promise<WhichResult> {
  const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
  let stdout: string
  try {
    const result = await run([lookup, name], { ...options, timeoutMs: Math.min(options.timeoutMs, 10_000) })
    stdout = result.stdout
  } catch (error) {
    return {
      reason:
        error instanceof ExecutableNotFoundError
          ? `${lookup} is not available to search PATH`
          : `PATH lookup failed (${error instanceof Error ? error.message : String(error)})`,
    }
  }
  const candidates = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (candidates.length === 0) return { reason: `${name} is not on PATH` }
  const usable = candidates.find(isRealExecutable)
  if (usable === undefined) {
    return { reason: `${name} resolves only to shell shims that cannot be launched directly (${candidates.join(', ')})` }
  }
  return { path: usable }
}

/**
 * Whether a resolved path can be launched without a shell. On Windows that means
 * a `.exe`/`.com` image; a `.cmd`/`.bat` shim would need `cmd.exe` and would put
 * the arguments back through command-line parsing, so it is rejected.
 * @param path - a path produced by `where`/`which`.
 * @returns true when `execFile` can launch it directly.
 */
export function isRealExecutable(path: string): boolean {
  if (process.platform !== 'win32') return true
  const extension = path.slice(path.lastIndexOf('.')).toLowerCase()
  return extension === '.exe' || extension === '.com'
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
