#!/usr/bin/env node
/**
 * Publish a release for the version currently in package.json.
 *
 * Creates the GitHub Release for `v<version>` (or reuses it), uploads
 * `<name>-<version>.tgz` as an asset, and applies repository topics. Run
 * `npm pack` first; the tarball must exist next to package.json.
 *
 *   GH_PAT=<token with repo scope> npm run release
 *
 * The token is read from the environment only — it is never written to a file,
 * and the remote URL never carries it.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const token = process.env.GH_PAT
if (!token) {
  console.error('release: GH_PAT is not set (needs a token with `repo` scope)')
  process.exit(1)
}

/**
 * Derive `owner/repo` without shelling out to git: read the origin URL straight
 * out of .git/config. This keeps the script working in confined environments
 * where spawning a child process is not permitted, and needs no git on PATH.
 */
function originSlug() {
  const fromEnv = process.env.GITHUB_REPOSITORY
  if (fromEnv !== undefined && /^[^/]+\/[^/]+$/.test(fromEnv)) {
    const [owner, repo] = fromEnv.split('/')
    return { owner, repo }
  }

  const configPath = join(ROOT, '.git', 'config')
  if (!existsSync(configPath)) {
    throw new Error(`cannot find ${configPath}; set GITHUB_REPOSITORY=owner/repo instead`)
  }
  const config = readFileSync(configPath, 'utf8')
  const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(config)
  const url = section === null ? undefined : /^\s*url\s*=\s*(\S+)\s*$/m.exec(section[1])?.[1]
  if (url === undefined) throw new Error('no origin remote url in .git/config; set GITHUB_REPOSITORY=owner/repo')
  const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)
  if (match === null) throw new Error(`cannot derive owner/repo from origin URL: ${url}`)
  return { owner: match[1], repo: match[2] }
}

const { owner, repo } = originSlug()
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const version = manifest.version
const tag = `v${version}`
const tarball = `${manifest.name}-${version}.tgz`
const tarballPath = join(ROOT, tarball)

if (!existsSync(tarballPath)) {
  console.error(`release: ${tarball} not found — run \`npm pack\` first`)
  process.exit(1)
}

const headers = {
  Authorization: `Bearer ${token}`,
  'User-Agent': `${manifest.name}-release`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
}

async function api(path, init) {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    ...init,
    headers: { ...headers, ...(init?.headers ?? {}) },
  })
  const text = await response.text()
  let body
  try {
    body = text === '' ? {} : JSON.parse(text)
  } catch {
    body = { raw: text.slice(0, 300) }
  }
  return { status: response.status, ok: response.ok, body }
}

const notes = `MarkItDown as a DeepSeek Harness tool: one \`markitdown\` tool that turns PDF, Word, Excel,
PowerPoint, HTML, CSV, EPUB, or a URL into Markdown an agent can read.

## Install

\`\`\`sh
dsh plugin --profile web add github:${owner}/${repo}
\`\`\`

Or from the tarball attached below:

\`\`\`sh
dsh plugin --profile web add ./${tarball}
\`\`\`

Then restart \`dsh web\`; the \`markitdown\` tool appears in the next session.

## Engines

The plugin drives a real MarkItDown installation when one is reachable — Microsoft's
\`markitdown\` CLI, \`uvx markitdown\`, or \`python -m markitdown\` — and falls back to a
dependency-free built-in converter when nothing is installed. The \`uvx\` engine defaults to
the \`markitdown[all]\` spec, because plain \`markitdown\` ships no format converters.

Nothing needs to be installed to get started. For PDF, OCR, audio, and full-fidelity Office
conversion, install \`markitdown[all]\` or \`uv\`.

## Highlights

- Relative paths resolve against the session workspace, matching the built-in file tools.
- \`output\` writes go through the filesystem seam, so the per-session sandbox policy and the
  read-before-write observation rule both apply.
- Subprocesses run with \`shell: false\`; only real executables are accepted.
- A missing input fails before any subprocess starts, with one clear sentence.
- Package-manager download chatter is filtered out of the tool result.
- 33 tests over synthetic OOXML fixtures — no network, Python, or MarkItDown required.

**Full Changelog**: https://github.com/${owner}/${repo}/commits/${tag}
`

let release = await api(`/releases/tags/${tag}`)
if (release.status === 404) {
  release = await api('/releases', {
    method: 'POST',
    body: JSON.stringify({ tag_name: tag, target_commitish: 'main', name: tag, body: notes, draft: false, prerelease: false }),
  })
}
if (!release.ok) {
  console.error(`release: create failed (${release.status}) ${JSON.stringify(release.body).slice(0, 300)}`)
  process.exit(1)
}
console.log(`release ${tag}: ${release.body.html_url}`)

const assets = await api(`/releases/${release.body.id}/assets`)
for (const asset of assets.body) {
  if (asset.name === tarball) {
    await api(`/releases/assets/${asset.id}`, { method: 'DELETE' })
    console.log(`replaced existing asset ${asset.name}`)
  }
}

const bytes = readFileSync(tarballPath)
const upload = await fetch(
  `https://uploads.github.com/repos/${owner}/${repo}/releases/${release.body.id}/assets?name=${encodeURIComponent(tarball)}`,
  { method: 'POST', headers: { ...headers, 'Content-Type': 'application/gzip' }, body: bytes },
)
if (!upload.ok) {
  console.error(`release: asset upload failed (${upload.status}) ${(await upload.text()).slice(0, 300)}`)
  process.exit(1)
}
console.log(`asset ${tarball}: ${bytes.length} bytes`)

const topics = await api('/topics', {
  method: 'PUT',
  body: JSON.stringify({
    names: [
      'dsh-plugin', 'deepseek-harness', 'dsh', 'cordis', 'markitdown', 'markdown',
      'pdf', 'docx', 'xlsx', 'pptx', 'epub', 'document-conversion', 'ocr', 'llm',
    ],
  }),
})
console.log(topics.ok ? `topics: ${topics.body.names.join(', ')}` : `topics: ${topics.status}`)
