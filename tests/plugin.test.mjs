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
import { EngineChain, filterEngineNoise } from '../lib/engine.js'

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
