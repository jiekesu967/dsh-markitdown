/**
 * Ad-hoc harness: drive the compiled plugin's tool definition without a live
 * harness, so the whole execute path (engine probe → subprocess/built-in →
 * canonical value) can be exercised during development.
 *
 * Usage: node scripts/dev-harness.mjs <engine> <input...>
 */
import { apply, Config } from '../lib/index.js'

const [engineArg, ...inputs] = process.argv.slice(2)

let definition
const ctx = {
  effect: (fn) => fn(),
  tools: { register: (def) => { definition = def; return () => {} } },
  get: () => undefined,
}

const config = {
  engine: engineArg,
  timeoutMs: 180_000,
  maxChars: 1_000_000,
  maxBytes: 64 * 1024 * 1024,
  allowUrls: true,
  extraArgs: [],
}
apply(ctx, config)

if (definition === undefined) throw new Error('tool was not registered')

for (const input of inputs) {
  const started = Date.now()
  try {
    const value = await definition.execute({ input }, { signal: new AbortController().signal })
    const preview = (value.markdown ?? '').split('\n').slice(0, 14).join('\n')
    console.log(`\n=== ${input}`)
    console.log(`engine   : ${value.engine}`)
    console.log(`chars    : ${value.chars}   elapsed: ${Date.now() - started} ms`)
    if (value.notes) console.log(`notes    : ${value.notes}`)
    console.log('--- preview ---')
    console.log(preview)
  } catch (error) {
    console.log(`\n=== ${input}`)
    console.log(`FAILED   : ${error.message}`)
  }
}
