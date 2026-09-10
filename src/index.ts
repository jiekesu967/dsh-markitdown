/**
 * dsh-markitdown — Microsoft MarkItDown as a DeepSeek Harness model tool.
 *
 * One tool, `markitdown`, turns a document, spreadsheet, presentation, web page,
 * or URL into Markdown the model can read. The plugin does not reimplement
 * MarkItDown and does not vendor it: it locates a real installation (Microsoft's
 * CLI, `uvx markitdown`, or a Python interpreter that already has the package)
 * and drives it, falling back to a dependency-free built-in converter so the
 * tool still answers when nothing is installed.
 *
 * Design notes worth keeping in mind when editing:
 * - One tool, small schema. The schema is priced into every request, so the
 *   description states the purpose and the long remediation text lives in tool
 *   results and error messages instead.
 * - Every side effect is owned by the fiber: the tool registration goes through
 *   `ctx.effect`, so reload and uninject remove it with no residue.
 * - Subprocesses are launched through `execFile` with `shell: false`; only real
 *   executables are accepted, so no input can reach a command line.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { FsTarget } from '@deepseek-ai/dsh-fs'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  BuiltinUnsupportedError,
  convertBuiltin,
  convertBuiltinResponse,
} from './builtin.js'
import { convertExternal, EngineChain, type EngineChoice, type EngineId, type ResolvedEngine } from './engine.js'
import { normalizeMarkdown } from './text.js'

/** Plugin id, matching the package name. */
export const name = 'dsh-markitdown'

/** The tool runtime is a hard dependency; the filesystem seam is optional. */
export const inject = ['tools']

/** Plugin configuration. */
export interface Config {
  /** Which engine to use; `auto` probes the chain in preference order. */
  engine: EngineChoice
  /** Explicit `markitdown` executable, overriding PATH lookup. */
  command?: string | undefined
  /** Package spec `uvx` runs; the extras are what make Office/PDF formats work. */
  uvxPackage: string
  /** Per-conversion deadline in milliseconds. */
  timeoutMs: number
  /** Maximum characters returned inline; longer output is truncated. */
  maxChars: number
  /** Maximum bytes the built-in engine will read into memory. */
  maxBytes: number
  /** Whether http(s) URL inputs are accepted. */
  allowUrls: boolean
  /** Extra arguments appended to every external engine invocation. */
  extraArgs: string[]
}

/** Configuration schema; every field is optional in `cordis.patch.yml`. */
export const Config = z.object({
  engine: z.string().default('auto'),
  command: z.string(),
  uvxPackage: z.string().default('markitdown[all]'),
  timeoutMs: z.number().default(120_000),
  maxChars: z.number().default(120_000),
  maxBytes: z.number().default(64 * 1024 * 1024),
  allowUrls: z.boolean().default(true),
  extraArgs: z.array(z.string()).default([]),
})

const ENGINE_IDS: readonly EngineId[] = ['markitdown', 'uvx', 'python', 'builtin']
const ENGINE_CHOICES = ['auto', ...ENGINE_IDS] as const

const REMEDIATION =
  'Install Microsoft MarkItDown for PDF, image OCR, audio, and full-fidelity Office support: ' +
  '`pip install "markitdown[all]"`, or install uv (https://docs.astral.sh/uv/) so `uvx markitdown` works.'

/**
 * Register the conversion tool.
 * @param ctx - the plugin context.
 * @param config - validated plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  if (!(ENGINE_CHOICES as readonly string[]).includes(config.engine)) {
    throw new Error(
      `dsh-markitdown: unknown engine "${config.engine}" in configuration; expected one of ${ENGINE_CHOICES.join(', ')}`,
    )
  }

  const chain = new EngineChain({
    choice: config.engine,
    command: config.command,
    uvxPackage: config.uvxPackage,
    probeTimeoutMs: Math.min(config.timeoutMs, 60_000),
  })
  /** One-off chains for per-call engine overrides; the configured chain keeps its cache. */
  const overrides = new Map<EngineId, EngineChain>()

  const chainFor = (choice: EngineChoice): EngineChain => {
    // The model's `auto` means "whatever this deployment does by default", so it
    // resolves to the configured chain rather than overriding it. Only naming a
    // specific engine buys a different chain.
    if (choice === 'auto' || choice === config.engine) return chain
    let existing = overrides.get(choice)
    if (existing === undefined) {
      existing = new EngineChain({
        choice,
        command: config.command,
        uvxPackage: config.uvxPackage,
        probeTimeoutMs: Math.min(config.timeoutMs, 60_000),
      })
      overrides.set(choice, existing)
    }
    return existing
  }

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'markitdown',
          description:
            'Convert a document, spreadsheet, presentation, web page, or URL to Markdown so you can read it. ' +
            'Use this before reading any non-text file (PDF, Word, Excel, PowerPoint, EPUB, HTML, CSV).',
          timeoutMs: config.timeoutMs + 60_000,
          parameters: {
            input: {
              type: 'string',
              required: true,
              description: 'Absolute or workspace-relative file path, or an http(s) URL.',
            },
            output: {
              type: 'string',
              description: 'Write the Markdown to this path instead of returning it inline. Use for long documents.',
            },
            engine: {
              type: 'string',
              enum: ENGINE_CHOICES,
              description: 'Force one engine for this call; defaults to the configured engine.',
            },
          },
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                engine: { type: 'string', required: true },
                input: { type: 'string', required: true },
                chars: { type: 'integer', required: true },
                truncated: { type: 'boolean', required: true },
                markdown: { type: 'string' },
                outputPath: { type: 'string' },
                notes: { type: 'string' },
              },
            },
            render: (_args, value) => {
              const lines: string[] = [
                value.outputPath === undefined
                  ? `Converted ${value.input} with ${value.engine} — ${value.chars} characters of Markdown.`
                  : `Converted ${value.input} with ${value.engine} — wrote ${value.chars} characters to ${value.outputPath}.`,
              ]
              if (value.truncated) {
                lines.push(
                  `[Output truncated to ${config.maxChars} characters. Re-run with an "output" path to capture the whole document.]`,
                )
              }
              if (value.notes !== undefined && value.notes !== '') lines.push(value.notes)
              if (value.markdown !== undefined && value.markdown !== '') lines.push('', value.markdown)
              return [{ type: 'text', text: lines.join('\n') }]
            },
          },
          presentCall: (args) => ({
            card: 'generic',
            title: `Convert to Markdown: ${shortName(args.input)}`,
            kind: 'read',
            rawInput: args.input,
          }),
          async execute(args, exec) {
            const raw = args.input.trim()
            if (raw === '') throw new Error('input is empty')
            if (args.engine !== undefined && !(ENGINE_CHOICES as readonly string[]).includes(args.engine)) {
              throw new Error(`unknown engine "${args.engine}"; expected one of ${ENGINE_CHOICES.join(', ')}`)
            }
            const requested: EngineChoice = args.engine ?? config.engine
            // Relative paths resolve against the calling session's workspace,
            // exactly like the built-in file tools; the filesystem backend's own
            // default would be the host process cwd, which is a different place.
            const cwd = exec.agent?.session.header.cwd

            const target = parseInput(raw, config.allowUrls)
            const activeChain = chainFor(requested)
            const engine = await activeChain.resolve(exec.signal)
            const notes: string[] = []

            const markdown = await convert(target, engine, activeChain, {
              config,
              signal: exec.signal,
              ctx,
              notes,
              cwd,
            })

            const chars = markdown.length
            const result: {
              engine: string
              input: string
              chars: number
              truncated: boolean
              markdown?: string
              outputPath?: string
              notes?: string
            } = {
              engine: engine.label,
              input: raw,
              chars,
              truncated: false,
            }

            if (args.output !== undefined && args.output.trim() !== '') {
              result.outputPath = await writeOutput(ctx, args.output.trim(), markdown, exec.signal, exec.agent?.session)
              notes.push(
                `The full Markdown is on disk at ${result.outputPath}; read it with the file tools instead of converting again.`,
              )
            } else if (chars > config.maxChars) {
              result.truncated = true
              result.markdown = markdown.slice(0, config.maxChars)
            } else {
              result.markdown = markdown
            }

            if (notes.length > 0) result.notes = notes.join('\n')
            return result
          },
        }),
      ),
    'dsh-markitdown: markitdown tool',
  )
}

type ParsedInput = { kind: 'file'; raw: string } | { kind: 'url'; url: string }

function parseInput(raw: string, allowUrls: boolean): ParsedInput {
  if (/^https?:\/\//i.test(raw)) {
    if (!allowUrls) throw new Error('URL inputs are disabled by this plugin\'s configuration (allowUrls: false)')
    return { kind: 'url', url: raw }
  }
  if (/^file:\/\//i.test(raw)) return { kind: 'file', raw: fileURLToPath(raw) }
  return { kind: 'file', raw }
}

/** Convert one parsed input, choosing the built-in path or an external engine. */
async function convert(
  target: ParsedInput,
  engine: ResolvedEngine,
  chain: EngineChain,
  options: { config: Config; signal: AbortSignal; ctx: Context; notes: string[]; cwd: string | undefined },
): Promise<string> {
  const { config, signal, ctx, notes, cwd } = options

  // Resolve a local input once, up front: the same resolution feeds both engine
  // families, and checking it here turns a missing file into one clear sentence
  // instead of an engine traceback.
  const file = target.kind === 'url' ? undefined : await resolveInputFile(ctx, target.raw, signal, cwd)

  if (engine.internal) {
    // Only mention remediation when a real engine was actually looked for and
    // rejected; an explicit `engine: "builtin"` call needs no lecture.
    if (chain.log.some((line) => /^(markitdown|uvx|python):/.test(line))) {
      notes.push(`Using the built-in converter. ${REMEDIATION}`)
    }
    try {
      return await convertWithBuiltin(target, file, ctx, config, signal)
    } catch (error) {
      if (error instanceof BuiltinUnsupportedError) {
        throw new Error(
          `${error.message}. The built-in converter cannot read this format. ${REMEDIATION} ` +
            `Probe log: ${chain.log.join('; ')}`,
        )
      }
      throw error
    }
  }

  const input = file === undefined ? (target as { url: string }).url : file.processPath
  const outcome = await convertExternal(engine, input, {
    timeoutMs: config.timeoutMs,
    signal,
    extraArgs: config.extraArgs,
  })
  if (outcome.stderr !== '') notes.push(`engine stderr: ${truncate(outcome.stderr, 600)}`)
  return normalizeMarkdown(outcome.markdown)
}

/** Build the resolve options the filesystem seam expects; mirrors `dsh-tool-fs`. */
function resolveOptions(cwd: string | undefined, signal: AbortSignal): { cwd?: string; signal: AbortSignal } {
  return cwd === undefined ? { signal } : { cwd, signal }
}

/** A local input that has been resolved and confirmed to be a readable file. */
interface ResolvedFile {
  /** Absolute path a subprocess can open. */
  processPath: string
  /** The seam target, present only when the filesystem service is available. */
  target?: FsTarget
}

/**
 * Resolve a local input path and prove it is a regular file.
 * Relative paths resolve against the session workspace, like the built-in file
 * tools; the check runs before any engine launch so a typo costs nothing.
 * @param ctx - plugin context, for the filesystem seam.
 * @param raw - the caller's path.
 * @param signal - cancellation.
 * @param cwd - the calling session's workspace root.
 * @returns the resolved file.
 */
async function resolveInputFile(
  ctx: Context,
  raw: string,
  signal: AbortSignal,
  cwd: string | undefined,
): Promise<ResolvedFile> {
  const expanded = expandHome(raw)
  const fs = ctx.get('fs')
  if (fs !== undefined) {
    const target = await fs.resolve(expanded, resolveOptions(cwd, signal))
    const processPath = fs.processPath(target)
    const info = await fs.stat(target, signal)
    if (info === undefined) throw new Error(`input not found: ${processPath}`)
    if (info.type === 'directory') throw new Error(`input is a directory, not a file: ${processPath}`)
    if (info.type !== 'file') throw new Error(`input is not a regular file: ${processPath}`)
    return { processPath, target }
  }

  const absolute = isAbsolute(expanded) ? expanded : resolvePath(cwd ?? process.cwd(), expanded)
  try {
    await access(absolute)
  } catch {
    throw new Error(`input not found: ${absolute}`)
  }
  return { processPath: absolute }
}

async function convertWithBuiltin(
  target: ParsedInput,
  file: ResolvedFile | undefined,
  ctx: Context,
  config: Config,
  signal: AbortSignal,
): Promise<string> {
  if (target.kind === 'url') {
    const response = await fetchWithLimit(target.url, config, signal)
    return convertBuiltinResponse(response.body, response.contentType, response.name)
  }
  if (file === undefined) throw new Error('internal error: file input was not resolved')

  const fs = ctx.get('fs')
  if (fs !== undefined && file.target !== undefined) {
    const bytes = Buffer.from(await fs.readBytes(file.target, signal, config.maxBytes))
    return convertBuiltin(bytes, file.processPath)
  }
  const bytes = await readFile(file.processPath)
  return convertBuiltin(bytes, file.processPath)
}

async function fetchWithLimit(
  url: string,
  config: Config,
  signal: AbortSignal,
): Promise<{ body: Buffer; contentType: string; name: string }> {
  if (typeof fetch !== 'function') {
    throw new Error('this Node.js runtime has no global fetch, so the built-in engine cannot read URLs')
  }
  const timeout = AbortSignal.timeout(config.timeoutMs)
  const combined = typeof AbortSignal.any === 'function' ? AbortSignal.any([signal, timeout]) : timeout
  const response = await fetch(url, { signal: combined, redirect: 'follow' })
  if (!response.ok) throw new Error(`fetch ${url} failed with HTTP ${response.status} ${response.statusText}`)
  const body = Buffer.from(await response.arrayBuffer())
  if (body.length > config.maxBytes) {
    throw new Error(`fetched ${body.length} bytes, above the configured maxBytes of ${config.maxBytes}`)
  }
  const name = new URL(url).pathname.split('/').pop() ?? 'index.html'
  return { body, contentType: response.headers.get('content-type') ?? '', name }
}

async function writeOutput(
  ctx: Context,
  rawOutput: string,
  markdown: string,
  signal: AbortSignal,
  session: Agent['session'] | undefined,
): Promise<string> {
  const fs = ctx.get('fs')
  if (fs !== undefined) {
    // Mirror `dsh-tool-fs`: the per-session sandbox policy supplies both the
    // write mode and the workspace root the path must land inside, otherwise the
    // backend fences the write against its own (host-level) default root.
    const sandbox = ctx.get('sandboxPolicy')
    const policy = sandbox?.resolve(session === undefined ? undefined : { session })
    const target = await fs.resolve(expandHome(rawOutput), resolveOptions(policy?.workspaceRoot, signal))
    // Observe an existing file first: the filesystem policy turns an unobserved
    // write into a create-if-absent intent, which would fail on a real file.
    const info = await fs.stat(target, signal)
    if (info !== undefined) {
      try {
        await fs.readText(target, signal)
      } catch {
        // Unreadable (binary or oversized) — let the guarded write report it.
      }
    }
    await fs.writeText(target, markdown, undefined, signal, policy)
    return fs.processPath(target)
  }

  const expanded = expandHome(rawOutput)
  const absolute = isAbsolute(expanded) ? expanded : resolvePath(process.cwd(), expanded)
  await mkdir(dirname(absolute), { recursive: true })
  await writeFile(absolute, markdown, 'utf8')
  return absolute
}

function expandHome(path: string): string {
  if (path === '~') return process.env.HOME ?? process.env.USERPROFILE ?? path
  if (path.startsWith('~/') || path.startsWith('~\\')) {
    const home = process.env.HOME ?? process.env.USERPROFILE
    if (home !== undefined) return resolvePath(home, path.slice(2))
  }
  return path
}

function shortName(input: string): string {
  const trimmed = input.trim()
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return basename(new URL(trimmed).pathname) || trimmed
    } catch {
      return trimmed
    }
  }
  return basename(trimmed) || trimmed
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`
}
