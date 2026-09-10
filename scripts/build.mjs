#!/usr/bin/env node
/**
 * Build src/ → lib/, in one Node process and without a shell.
 *
 * `scripts/build.sh` is a thin wrapper over this file; running the build here
 * keeps it working on Windows, in CI, and in confined environments where
 * spawning a child process with piped stdio is not permitted. TypeScript is
 * driven through its own compiler API rather than as a child process, so no
 * process is spawned at all.
 *
 * TypeScript is taken from $DSH_TSC (a path to typescript.js), then the project,
 * then a `.tools/typescript` beside the workspace, then the DSH checkout.
 */
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { linkDependencies } from './link-deps.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Locate `typescript.js` from the environment or the usual install locations. */
function findTypeScript() {
  const candidates = [
    process.env.DSH_TSC,
    join(ROOT, 'node_modules', 'typescript', 'lib', 'typescript.js'),
    join(ROOT, '..', '.tools', 'ts', 'package', 'lib', 'typescript.js'),
    process.env.DSH_CHECKOUT === undefined
      ? undefined
      : join(process.env.DSH_CHECKOUT, 'node_modules', 'typescript', 'lib', 'typescript.js'),
    process.env.DSH_RUNTIME === undefined
      ? undefined
      : join(process.env.DSH_RUNTIME, 'node_modules', 'typescript', 'lib', 'typescript.js'),
  ]
  return candidates.find((candidate) => candidate !== undefined && existsSync(candidate))
}

let linked
try {
  linked = linkDependencies()
} catch (error) {
  console.error(`build: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
console.log(`build: linked ${linked.count} DSH packages from ${linked.source.kind} ${linked.source.root}`)

const typescriptPath = findTypeScript()
if (typescriptPath === undefined) {
  console.error('build: cannot find typescript.js.')
  console.error('Install it (`npm install --save-dev typescript`) or point DSH_TSC at a typescript.js.')
  process.exit(1)
}

const ts = createRequire(import.meta.url)(typescriptPath)
console.log(`build: typescript ${ts.version}`)

// `executeCommandLine` terminates through `sys.exit`; capturing it here keeps
// the compiler from taking the build process down before we can report the code.
let exitCode = 0
const sys = {
  ...ts.sys,
  exit: (code) => {
    exitCode = typeof code === 'number' ? code : 0
  },
}

// Extra arguments are forwarded to tsc, so `node scripts/build.mjs --noEmit`
// is a type check and nothing else.
const forwarded = process.argv.slice(2)
console.log(`build: compiling src -> lib${forwarded.length === 0 ? '' : ` (${forwarded.join(' ')})`}`)
ts.executeCommandLine(sys, ts.noop, ['-p', join(ROOT, 'tsconfig.json'), ...forwarded])

if (exitCode !== 0) {
  console.error(`build: tsc reported errors (exit ${exitCode})`)
  process.exit(exitCode)
}
console.log('build: complete')
