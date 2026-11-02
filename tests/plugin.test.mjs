/**
 * Plugin-surface tests: engine selection, diagnostic filtering, and the tool's
 * canonical result shape. They drive the compiled plugin through a minimal
 * context double, so they exercise the real execute path without a live harness.
 */
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { apply, Config } from '../lib/index.js'
import { EngineChain, convertExternal, filterEngineNoise } from '../lib/engine.js'

/** A context double exposing exactly the seams the plugin uses. */
function harness(options = {}) {
  let definition
  const context = {
    effect: (fn) => fn(),
    tools: { register: (registered) => { definition = registered; return () => {} } },
    get: (name) => (name === 'fs' ? undefined : options.services?.[name]),
  }
  apply(context, Config({
    engine: 'builtin',
    timeoutMs: 30_000,
    maxChars: 100_000,
    maxBytes: 8 * 1024 * 1024,
    allowUrls: false,
    extraArgs: [],
  }))
  assert.ok(definition, 'apply() must register the tool')
  return definition
}

const exec = () => ({ signal: new AbortController().signal, agent: undefined })

test('config schema supplies defaults and accepts overrides', () => {
  const config = Config({})
  assert.equal(config.engine, 'auto')
  assert.equal(config.uvxPackage, 'markitdown[all]')
  assert.equal(config.allowUrls, true)
  assert.equal(config.maxChars, 120_000)
  const overridden = Config({ engine: 'builtin', maxChars: 10 })
  assert.equal(overridden.maxChars, 10)
})

test('the tool advertises one narrow, well-formed interface', () => {
  const definition = harness()
  assert.equal(definition.name, 'markitdown')
  // `parameters` is the compiled JSON Schema, not the author-facing spec.
  assert.equal(definition.parameters.type, 'object')
  assert.deepEqual(Object.keys(definition.parameters.properties).sort(), ['engine', 'input', 'output'])
  assert.deepEqual([...definition.parameters.required], ['input'])
  assert.deepEqual(
    [...definition.parameters.properties.engine.enum],
    ['auto', 'markitdown', 'uvx', 'python', 'builtin'],
  )
  assert.ok(definition.description.length < 300, 'the description is priced into every request')
})

test('a builtin conversion returns the canonical result shape', async () => {
  const definition = harness()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-markitdown-'))
  try {
    const file = join(directory, 'rows.csv')
    await writeFile(file, 'a,b\n1,2\n', 'utf8')
    const value = await definition.execute({ input: file }, exec())
    assert.equal(value.truncated, false)
    assert.match(value.engine, /built-in/)
    assert.match(value.markdown, /\| a \| b \|/)
    assert.ok(value.chars > 0)
    const rendered = definition.output.render({ input: file }, value)
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /Converted/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a missing input fails before any engine runs', async () => {
  const definition = harness()
  await assert.rejects(
    () => definition.execute({ input: join(tmpdir(), 'definitely-absent-9f3a.docx') }, exec()),
    /input not found/,
  )
})

test('an unsupported format explains the fix instead of guessing', async () => {
  const definition = harness()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-markitdown-'))
  try {
    const file = join(directory, 'scan.pdf')
    await writeFile(file, '%PDF-1.4\n', 'utf8')
    await assert.rejects(
      () => definition.execute({ input: file }, exec()),
      (error) => /built-in converter cannot read this format/.test(error.message) && /pip install/.test(error.message),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('URL input is refused when the configuration disables it', async () => {
  const definition = harness()
  await assert.rejects(() => definition.execute({ input: 'https://example.com' }, exec()), /allowUrls/)
})

test('an unknown engine argument is rejected at the schema boundary', async () => {
  const definition = harness()
  await assert.rejects(
    () => definition.execute({ input: 'x.txt', engine: 'nope' }, exec()),
    /engine.*must be one of|unknown engine/,
  )
})

test('output truncation is reported rather than silently losing text', async () => {
  let definition
  const context = {
    effect: (fn) => fn(),
    tools: { register: (registered) => { definition = registered; return () => {} } },
    get: () => undefined,
  }
  apply(context, Config({ engine: 'builtin', maxChars: 16, allowUrls: false }))
  const directory = await mkdtemp(join(tmpdir(), 'dsh-markitdown-'))
  try {
    const file = join(directory, 'long.txt')
    await writeFile(file, 'x'.repeat(200), 'utf8')
    const value = await definition.execute({ input: file }, exec())
    assert.equal(value.truncated, true)
    assert.equal(value.markdown.length, 16)
    assert.equal(value.chars, 200)
    assert.match(definition.output.render({ input: file }, value)[0].text, /truncated/i)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('writing to an output path keeps the body out of the result', async () => {
  const definition = harness()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-markitdown-'))
  try {
    const source = join(directory, 'in.txt')
    const destination = join(directory, 'out.md')
    await writeFile(source, 'hello world', 'utf8')
    const value = await definition.execute({ input: source, output: destination }, exec())
    assert.equal(value.outputPath, destination)
    assert.equal(value.markdown, undefined, 'the inline body is redundant once written')
    const first = await import('node:fs/promises').then((fs) => fs.readFile(destination, 'utf8'))
    assert.equal(first, 'hello world')

    // Overwriting the same path must work: the write is observed first.
    const again = await definition.execute({ input: source, output: destination }, exec())
    assert.equal(again.outputPath, destination)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an explicitly unavailable engine fails with remediation, not a fallback', async () => {
  const chain = new EngineChain({
    choice: 'markitdown',
    command: join(tmpdir(), 'no-such-markitdown-binary'),
    probeTimeoutMs: 5_000,
  })
  await assert.rejects(
    () => chain.resolve(new AbortController().signal),
    (error) => /not available/.test(error.message) && /pip install/.test(error.message),
  )
})

test('an unknown configured engine fails loudly at mount', () => {
  assert.throws(
    () => apply({ effect: (fn) => fn(), tools: { register: () => () => {} }, get: () => undefined }, Config({ engine: 'bogus' })),
    /unknown engine "bogus"/,
  )
})

test('the builtin engine is always resolvable, even alone', async () => {
  const chain = new EngineChain({ choice: 'builtin', probeTimeoutMs: 5_000 })
  const engine = await chain.resolve(new AbortController().signal)
  assert.equal(engine.id, 'builtin')
  assert.equal(engine.internal, true)
})

test('package-manager chatter is filtered out of diagnostics', () => {
  const raw = [
    'Downloading numpy (12.0MiB)',
    ' Downloaded numpy',
    'Installed 25 packages in 890ms',
    'Resolved 54 packages in 1.13s',
    'Traceback (most recent call last):',
    'FileConversionException: conversion failed',
  ].join('\n')
  const filtered = filterEngineNoise(raw)
  assert.ok(!filtered.includes('Downloading'))
  assert.ok(!filtered.includes('Installed 25 packages'))
  assert.match(filtered, /Traceback/)
  assert.match(filtered, /FileConversionException/)
  assert.equal(filterEngineNoise('Downloading a (1MiB)\n'), '')
})

/** A harness double that accepts URL input, for the fetch-path tests. */
function fetchHarness() {
  let definition
  const context = {
    effect: (fn) => fn(),
    tools: { register: (registered) => { definition = registered; return () => {} } },
    get: () => undefined,
  }
  apply(context, Config({ engine: 'builtin', timeoutMs: 30_000, maxBytes: 8 * 1024 * 1024, allowUrls: true }))
  return definition
}

function stubFetch(responder) {
  const original = globalThis.fetch
  globalThis.fetch = responder
  return () => { globalThis.fetch = original }
}

test('a URL response over maxBytes is refused before it is fully buffered', async () => {
  const restore = stubFetch(async () => ({ ok: true, status: 200, statusText: 'OK', headers: { get: () => null }, body: null, arrayBuffer: async () => new ArrayBuffer(9 * 1024 * 1024) }))
  const definition = fetchHarness()
  try {
    // No content-length header: the streamed body itself must enforce the cap.
    await assert.rejects(
      () => definition.execute({ input: 'https://example.com/big' }, exec()),
      (error) => /maxBytes/.test(error.message),
    )
  } finally {
    restore()
  }
})

test('a declared content-length over maxBytes is refused without downloading', async () => {
  let downloaded = false
  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name) => (name === 'content-length' ? String(9 * 1024 * 1024) : 'text/plain') },
    body: null,
    arrayBuffer: async () => { downloaded = true; return new ArrayBuffer(0) },
  }))
  const definition = fetchHarness()
  try {
    await assert.rejects(
      () => definition.execute({ input: 'https://example.com/declared' }, exec()),
      (error) => /declares \d+ bytes/.test(error.message),
    )
    assert.equal(downloaded, false, 'the body must not be read when the declared size already exceeds the cap')
  } finally {
    restore()
  }
})

test('a directory-like URL falls back to index.html rather than an empty name', async () => {
  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: { get: (name) => (name === 'content-type' ? 'application/octet-stream' : null) },
    body: null,
    arrayBuffer: async () => new TextEncoder().encode('<h1>Title</h1>').buffer,
  }))
  const definition = fetchHarness()
  try {
    const value = await definition.execute({ input: 'https://example.com/docs/' }, exec())
    assert.match(value.markdown, /# Title/)
  } finally {
    restore()
  }
})

test('a local file above maxBytes fails in the seamless fallback path too', async () => {
  const definition = harness()
  const directory = await mkdtemp(join(tmpdir(), 'dsh-markitdown-'))
  try {
    const file = join(directory, 'big.txt')
    await writeFile(file, 'x'.repeat(8 * 1024 * 1024 + 1), 'utf8')
    await assert.rejects(
      () => definition.execute({ input: file }, exec()),
      (error) => /maxBytes/.test(error.message),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a process whose output exceeds the capture limit reports that, not a timeout', async () => {
  const { run } = await import('../lib/exec.js')
  await assert.rejects(
    () =>
      run([process.execPath, '-e', 'process.stdout.write("a".repeat(8 * 1024 * 1024))'], {
        timeoutMs: 120_000,
        maxBuffer: 64 * 1024,
      }),
    (error) => /output capture limit/.test(error.message) && !/deadline/.test(error.message),
  )
})

test('the markitdown CLI engine hands PYTHON_ENV to its child process', async () => {
  // Regression guard for the CLI branch, which used to pass `env: undefined`.
  // On a Windows ANSI code page that is not UTF-8 the CLI then encoded stdout
  // with the local code page (cp1251, cp936, …) while exec.js decoded it as
  // UTF-8: every non-ASCII character became U+FFFD, exit code 0, no warning.
  // The parent must not already carry these variables, or run() would inherit
  // them and the assertion below would hold even with the bug present.
  const saved = { PYTHONUTF8: process.env.PYTHONUTF8, PYTHONIOENCODING: process.env.PYTHONIOENCODING }
  delete process.env.PYTHONUTF8
  delete process.env.PYTHONIOENCODING
  const directory = await mkdtemp(join(tmpdir(), 'dsh-markitdown-env-'))
  try {
    const probe = join(directory, 'echo-env.mjs')
    await writeFile(
      probe,
      'process.stdout.write(JSON.stringify({ utf8: process.env.PYTHONUTF8 ?? null, io: process.env.PYTHONIOENCODING ?? null }))\n',
      'utf8',
    )
    // Node stands in for the CLI: answering `--help` is all the availability probe asks.
    const chain = new EngineChain({ choice: 'markitdown', command: process.execPath, probeTimeoutMs: 60_000 })
    const engine = await chain.resolve()
    assert.equal(engine.id, 'markitdown')
    const { markdown } = await convertExternal(engine, probe, { timeoutMs: 60_000 })
    assert.deepEqual(JSON.parse(markdown), { utf8: '1', io: 'utf-8' })
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(directory, { recursive: true, force: true })
  }
})
