/**
 * The engine chain: find the best available MarkItDown implementation once, then
 * reuse it for the life of the plugin fiber.
 *
 * Preference order is deliberate. Microsoft's own CLI wins when it is installed;
 * `uvx` comes next because it runs the real package with no permanent install;
 * a Python interpreter already carrying the package is third; the built-in
 * converter is the floor that keeps the tool useful with nothing installed.
 */
import { ExecutableNotFoundError, run, which, type RunOptions } from './exec.js'

/** One concrete conversion backend. */
export type EngineId = 'markitdown' | 'uvx' | 'python' | 'builtin'

/** A user-facing engine selection, including automatic detection. */
export type EngineChoice = EngineId | 'auto'

/** An engine that has been proven available and is ready to launch. */
export interface ResolvedEngine {
  /** Stable identifier of the backend family. */
  id: EngineId
  /** Human-readable description used in results and error messages. */
  label: string
  /** Executable plus fixed leading arguments. Empty for the built-in engine. */
  argv: readonly string[]
  /** Extra environment applied to the child process. */
  env: Record<string, string> | undefined
  /** True when the plugin reads the bytes itself instead of invoking a program. */
  internal: boolean
}

/** Outcome of one external conversion. */
export interface ConversionOutcome {
  /** Converted Markdown. */
  markdown: string
  /** Diagnostics the engine printed on standard error. */
  stderr: string
}

const PYTHON_ENV: Record<string, string> = {
  PYTHONUTF8: '1',
  PYTHONIOENCODING: 'utf-8',
}

/** Resolves and caches the engine for one plugin instance. */
export class EngineChain {
  readonly #choice: EngineChoice
  readonly #command: string | undefined
  readonly #uvxPackage: string
  readonly #probeTimeoutMs: number
  #cached: ResolvedEngine | undefined
  #log: string[] = []

  constructor(options: {
    choice: EngineChoice
    command?: string | undefined
    /** Package spec `uvx` should run; the extras are what make Office formats work. */
    uvxPackage?: string | undefined
    probeTimeoutMs: number
  }) {
    this.#choice = options.choice
    this.#command = options.command
    this.#uvxPackage = options.uvxPackage ?? 'markitdown[all]'
    this.#probeTimeoutMs = options.probeTimeoutMs
  }

  /** Probe transcript of the most recent resolution, for diagnostics. */
  get log(): readonly string[] {
    return this.#log
  }

  /** Forget the cached engine so the next call re-probes. */
  invalidate(): void {
    this.#cached = undefined
  }

  /**
   * Resolve the engine to use, probing once and caching the winner.
   * @param signal - cancellation for the probe itself.
   * @returns the resolved engine.
   * @throws Error when an explicitly requested engine is unavailable.
   */
  async resolve(signal?: AbortSignal): Promise<ResolvedEngine> {
    if (this.#cached !== undefined) return this.#cached
    const options: RunOptions = { signal, timeoutMs: this.#probeTimeoutMs }
    this.#log = []

    const order: EngineId[] =
      this.#choice === 'auto' ? ['markitdown', 'uvx', 'python', 'builtin'] : [this.#choice]

    for (const id of order) {
      const engine = await this.#probe(id, options)
      if (engine !== undefined) {
        this.#cached = engine
        return engine
      }
      if (this.#choice !== 'auto') {
        throw new Error(
          `engine "${this.#choice}" is not available. ${this.#log.join('; ')}. ` +
            'Install Microsoft MarkItDown (pip install "markitdown[all]"), install uv (https://docs.astral.sh/uv/) ' +
            'so `uvx markitdown` works, or set engine to "builtin".',
        )
      }
    }

    throw new Error(`no conversion engine is available. ${this.#log.join('; ')}`)
  }

  async #probe(id: EngineId, options: RunOptions): Promise<ResolvedEngine | undefined> {
    switch (id) {
      case 'builtin':
        this.#log.push('builtin: always available')
        return { id, label: 'built-in converter (no external dependency)', argv: [], env: undefined, internal: true }

      case 'markitdown': {
        const found =
          this.#command === undefined ? await which('markitdown', options) : ({ path: this.#command } as const)
        if ('reason' in found) {
          this.#log.push(`markitdown: ${found.reason}`)
          return undefined
        }
        if (!(await this.#responds([found.path, '--help'], options))) {
          this.#log.push(`markitdown: ${found.path} did not respond to --help`)
          return undefined
        }
        this.#log.push(`markitdown: ${found.path}`)
        // The CLI is a Python entry point, so it needs the same environment the
        // other two Python-backed engines already pass: without PYTHONUTF8 its
        // stdout is encoded with the system ANSI code page (cp1251, cp936, …)
        // while exec.js decodes it as UTF-8 — every non-ASCII character becomes
        // U+FFFD and the conversion still exits 0.
        return { id, label: `markitdown CLI (${found.path})`, argv: [found.path], env: PYTHON_ENV, internal: false }
      }

      case 'uvx': {
        const found = await which('uvx', options)
        if ('reason' in found) {
          this.#log.push(`uvx: ${found.reason}`)
          return undefined
        }
        if (!(await this.#responds([found.path, '--version'], options))) {
          this.#log.push(`uvx: ${found.path} did not respond to --version`)
          return undefined
        }
        this.#log.push(`uvx: ${found.path} (first conversion downloads ${this.#uvxPackage})`)
        return {
          id,
          label: `uvx ${this.#uvxPackage} (${found.path})`,
          argv: [found.path, '--from', this.#uvxPackage, 'markitdown'],
          env: PYTHON_ENV,
          internal: false,
        }
      }

      case 'python': {
        let anyReason = 'python is not on PATH'
        for (const name of ['python', 'python3', 'py']) {
          const found = await which(name, options)
          if ('reason' in found) {
            anyReason = found.reason
            continue
          }
          if (!(await this.#responds([found.path, '-m', 'markitdown', '--help'], options))) {
            anyReason = `${found.path} has no markitdown module`
            continue
          }
          this.#log.push(`python: ${found.path} -m markitdown`)
          return {
            id,
            label: `python -m markitdown (${found.path})`,
            argv: [found.path, '-m', 'markitdown'],
            env: PYTHON_ENV,
            internal: false,
          }
        }
        this.#log.push(`python: ${anyReason}`)
        return undefined
      }
    }
  }

  async #responds(argv: readonly string[], options: RunOptions): Promise<boolean> {
    try {
      await run(argv, options)
      return true
    } catch (error) {
      if (error instanceof ExecutableNotFoundError) return false
      // A non-zero exit from `--help` still proves the program is installed and
      // executable, which is all the probe needs to establish.
      return /exited with status/.test(String(error))
    }
  }
}

/**
 * Run one conversion through an external engine.
 * @param engine - the resolved engine; must not be the built-in one.
 * @param input - absolute process path or URL handed to the engine.
 * @param options - deadline, cancellation, and extra CLI arguments.
 * @returns the converted Markdown and the engine's standard error.
 * @throws Error when the engine fails or produces no output.
 */
export async function convertExternal(
  engine: ResolvedEngine,
  input: string,
  options: { timeoutMs: number; signal?: AbortSignal | undefined; extraArgs?: readonly string[] },
): Promise<ConversionOutcome> {
  const argv = [...engine.argv, ...(options.extraArgs ?? []), input]
  let result
  try {
    result = await run(argv, {
      signal: options.signal,
      timeoutMs: options.timeoutMs,
      ...(engine.env === undefined ? {} : { env: engine.env }),
    })
  } catch (error) {
    if (error instanceof ExecutableNotFoundError) {
      throw new Error(`${engine.label} disappeared while converting ${input}: ${error.message}`)
    }
    throw error
  }
  const markdown = result.stdout.replace(/^\uFEFF/, '')
  if (markdown.trim() === '') {
    throw new Error(`${engine.label} produced no Markdown for ${input}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}`)
  }
  return { markdown, stderr: filterEngineNoise(result.stderr) }
}

/**
 * Drop the package-manager progress `uvx` prints on first use, keeping anything
 * that looks like a real diagnostic. Without this the first conversion returns
 * fifteen lines of download chatter to the model alongside the document.
 * @param stderr - raw standard error from the engine.
 * @returns the remaining diagnostic lines, trimmed.
 */
export function filterEngineNoise(stderr: string): string {
  const noise =
    /^\s*(Downloading|Downloaded|Installed|Resolved|Prepared|Audited|Building|Built|Installing|Uninstalling|Uninstalled|Creating|Updating|Updated|Using|Removed|warning: The `|note: )/
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== '' && !noise.test(line))
    .join('\n')
    .trim()
}
