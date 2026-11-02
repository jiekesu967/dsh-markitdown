#!/usr/bin/env node
/**
 * Link the DSH packages this plugin compiles against into ./node_modules.
 *
 * A plugin outside the DSH tree has no way to resolve `@deepseek-ai/cordis` and
 * friends by itself, so the build creates junctions to whichever copy of DSH is
 * present, in this order:
 *
 *   1. `$DSH_CHECKOUT` — a DSH source checkout, where the packages live under
 *      `vendor/*` and `packages/<group>/*` and are located by their package name.
 *   2. `$DSH_RUNTIME` — an installed `@deepseek-ai/dsh`, where everything sits in
 *      one flat `node_modules/@deepseek-ai` tree.
 *   3. the `dsh` launcher on `$PATH`, followed through its symlink to the package
 *      it runs. This is what finds versioned installs, such as
 *      `/usr/local/lib/nodejs/node-v22-linux-x64/lib/node_modules/@deepseek-ai/dsh`,
 *      which no fixed list of prefixes can predict.
 *   4. the usual global-install locations: this interpreter's own prefix, the
 *      Windows `%APPDATA%\npm` tree, and the system-wide trees.
 *   5. `npm root -g`, asked once, only after everything above is incomplete.
 *
 * Linking by package *name* means a checkout that reorganises its directories
 * still works; only the entry points are assumed.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Packages whose types the plugin's sources reference, directly or transitively. */
const REQUIRED = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cosmokit',
  '@deepseek-ai/schemastery',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-fs',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-sandbox',
  '@deepseek-ai/dsh-sandbox-policy',
  '@deepseek-ai/dsh-session',
]

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Read a directory's package.json name, or undefined. */
function packageName(directory) {
  const manifest = join(directory, 'package.json')
  if (!existsSync(manifest)) return undefined
  try {
    return JSON.parse(readFileSync(manifest, 'utf8')).name
  } catch {
    return undefined
  }
}

function subdirectories(directory) {
  if (!existsSync(directory)) return []
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(directory, entry.name))
}

/** Resolve a path through symlinks, or undefined when it cannot be read. */
function realpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/** Every directory on `$PATH`, split the way this platform expects. */
function pathDirectories() {
  const entries = (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')
  return entries.filter((entry) => entry !== '')
}

/** The installed `@deepseek-ai/dsh` package a file belongs to, if any, walking up from it. */
function installedPackage(path) {
  let directory = dirname(path)
  for (let depth = 0; depth < 8; depth += 1) {
    if (packageName(directory) === '@deepseek-ai/dsh') return directory
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  return undefined
}

/**
 * The runtime whose `dsh` launcher comes first on `$PATH`.
 * Following the launcher finds versioned Node installs such as
 * `<prefix>/node-v22-linux-x64/bin/dsh` → `<prefix>/node-v22-linux-x64/lib/node_modules/@deepseek-ai/dsh`.
 */
function pathRuntime() {
  const launchers = process.platform === 'win32' ? ['dsh.cmd', 'dsh.exe', 'dsh.bat', 'dsh'] : ['dsh']
  for (const directory of pathDirectories()) {
    for (const launcher of launchers) {
      const path = join(directory, launcher)
      if (!existsSync(path)) continue
      const resolved = realpath(path)
      const installed = resolved === undefined ? undefined : installedPackage(resolved)
      if (installed !== undefined) return installed
    }
  }
  return undefined
}

/**
 * Ask npm where its global root is. This is the only probe that spawns a process,
 * so it runs last and only when nothing cheaper was complete.
 */
function npmGlobalRoot() {
  const windows = process.platform === 'win32'
  try {
    const output = execFileSync(windows ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      windowsHide: true,
      shell: windows,
    })
    const root = output.trim()
    return root === '' ? undefined : root
  } catch {
    return undefined
  }
}

/** Index every package in a source checkout by its declared name. */
function indexCheckout(root) {
  const index = new Map()
  const visit = (directory, depth) => {
    const name = packageName(directory)
    if (name !== undefined && !index.has(name)) index.set(name, directory)
    if (depth === 0) return
    for (const child of subdirectories(directory)) visit(child, depth - 1)
  }
  for (const group of subdirectories(join(root, 'packages'))) visit(group, 1)
  for (const vendor of subdirectories(join(root, 'vendor'))) visit(vendor, 0)
  return index
}

/** Every source worth probing, the explicit and cheapest first. */
function candidateSources() {
  const candidates = []

  // Explicit configuration always wins.
  if (process.env.DSH_CHECKOUT) candidates.push({ kind: 'checkout', root: process.env.DSH_CHECKOUT })
  if (process.env.DSH_RUNTIME) candidates.push({ kind: 'runtime', root: process.env.DSH_RUNTIME })

  // The `dsh` the user actually runs, wherever their Node install lives.
  const fromPath = pathRuntime()
  if (fromPath !== undefined) candidates.push({ kind: 'runtime', root: fromPath })

  // Checkouts and global installs in the usual places.
  candidates.push(
    { kind: 'checkout', root: join(homedir(), 'dsh-harness') },
    { kind: 'checkout', root: join(homedir(), 'dsh') },
    { kind: 'checkout', root: join(homedir(), '.dsh', 'dsh-harness') },
    { kind: 'runtime', root: join(dirname(process.execPath), '..', 'lib', 'node_modules', '@deepseek-ai', 'dsh') },
    {
      kind: 'runtime',
      root:
        process.env.APPDATA === undefined
          ? ''
          : join(process.env.APPDATA, 'npm', 'node_modules', '@deepseek-ai', 'dsh'),
    },
    { kind: 'runtime', root: join(homedir(), 'AppData', 'Roaming', 'npm', 'node_modules', '@deepseek-ai', 'dsh') },
    { kind: 'runtime', root: '/usr/local/lib/node_modules/@deepseek-ai/dsh' },
    { kind: 'runtime', root: '/usr/lib/node_modules/@deepseek-ai/dsh' },
  )
  return candidates
}

/**
 * Resolve every required package from one source.
 * @returns {{ source: object, resolved: Map<string, string> } | { attempt: string } | undefined}
 *   the resolution, why this source was incomplete, or undefined when it does not exist.
 */
function resolveFrom(candidate) {
  if (candidate.root === '' || !existsSync(candidate.root)) return undefined
  const index = candidate.kind === 'checkout' ? indexCheckout(candidate.root) : undefined
  const resolved = new Map()
  const missing = []
  for (const name of REQUIRED) {
    const directory =
      index === undefined ? join(candidate.root, 'node_modules', ...name.split('/')) : index.get(name)
    if (directory !== undefined && existsSync(directory)) resolved.set(name, directory)
    else missing.push(name)
  }
  if (missing.length === 0) return { source: candidate, resolved }
  return { attempt: `${candidate.kind} ${candidate.root}: missing ${missing.join(', ')}` }
}

/** Resolve every required package from the first source that has all of them. */
function resolveSources() {
  const attempts = []
  const consider = (candidate) => {
    const result = resolveFrom(candidate)
    if (result === undefined) return undefined
    if (result.attempt !== undefined) attempts.push(result.attempt)
    return result.resolved === undefined ? undefined : result
  }

  for (const candidate of candidateSources()) {
    const found = consider(candidate)
    if (found !== undefined) return found
  }

  // Nothing local was complete; let npm name its global root before giving up.
  const npmRoot = npmGlobalRoot()
  if (npmRoot !== undefined) {
    const found = consider({ kind: 'runtime', root: join(npmRoot, '@deepseek-ai', 'dsh') })
    if (found !== undefined) return found
  }

  return { attempts }
}

/** Create (or refresh) a directory junction/symlink at `link` pointing at `target`. */
function link(linkPath, target) {
  rmSync(linkPath, { recursive: true, force: true })
  mkdirSync(dirname(linkPath), { recursive: true })
  symlinkSync(resolve(target), linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

/**
 * Link every required package, or explain why that is impossible.
 * @param {string} root - project root that receives the `node_modules` links.
 * @returns {{ source: { kind: string, root: string }, count: number, types: boolean }} what was linked.
 * @throws {Error} when no source has the complete package set.
 */
export function linkDependencies(root = ROOT) {
  const result = resolveSources()
  if (result.resolved === undefined) {
    const tried = result.attempts.map((attempt) => `  tried ${attempt}`).join('\n')
    throw new Error(
      'could not locate a complete set of DSH packages.\n' +
        'Set DSH_CHECKOUT (a DSH source checkout) or DSH_RUNTIME (an installed @deepseek-ai/dsh),\n' +
        'or put the dsh CLI on PATH.\n' +
        tried,
    )
  }

  for (const [name, target] of result.resolved) link(join(root, 'node_modules', ...name.split('/')), target)

  const types = ['node_modules/@types/node'].map((rel) => join(result.source.root, rel)).find(existsSync)
  if (types !== undefined) link(join(root, 'node_modules', '@types', 'node'), types)

  return { source: result.source, count: result.resolved.size, types: types !== undefined }
}

// CLI entry: `node scripts/link-deps.mjs`
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const linked = linkDependencies()
    console.log(`link-deps: ${linked.source.kind} ${linked.source.root}`)
    console.log(`link-deps: linked ${linked.count} packages${linked.types ? '' : ' (no @types/node found)'}`)
  } catch (error) {
    console.error(`link-deps: ${error instanceof Error ? error.message : String(error)}`)
    process.exit(1)
  }
}
