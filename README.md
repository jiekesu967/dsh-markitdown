# dsh-markitdown

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/jiekesu967/dsh-markitdown)](https://github.com/jiekesu967/dsh-markitdown)

[Microsoft MarkItDown](https://github.com/microsoft/markitdown) as a DeepSeek Harness tool.
One tool, `markitdown`, turns a document into Markdown the model can actually read.

The model calls it before reading any non-text file:

```
markitdown({ input: "reports/q3.pdf" })
markitdown({ input: "data/forecast.xlsx", output: "notes/forecast.md" })
markitdown({ input: "https://example.com/spec.html" })
```

## Why this exists

A text-only model cannot open a PDF, a spreadsheet, or a slide deck. MarkItDown solves
that well — but it is a Python package, and a harness plugin needs to reach it without
assuming a specific Python environment, a specific install layout, or that anything is
installed at all.

So this plugin does not reimplement MarkItDown and does not vendor it. It looks for a
real installation, drives it, and falls back to a built-in converter when there is none:

| Order | Engine | What it is | Needs |
| --- | --- | --- | --- |
| 1 | `markitdown` | Microsoft's own CLI | `pip install "markitdown[all]"` |
| 2 | `uvx markitdown` | the real package, run without installing it | [uv](https://docs.astral.sh/uv/) |
| 3 | `python -m markitdown` | a Python that already has the package | Python 3.10+ with MarkItDown |
| 4 | built-in | a dependency-free converter shipped in this plugin | nothing |

Order 2 is usually the best deal: if `uv` is on the machine, the **real** MarkItDown runs
with no permanent install. It defaults to the `markitdown[all]` spec so Office and PDF
formats actually work — plain `markitdown` has no format converters at all.

Order 4 keeps the tool useful on a bare machine. It is honest about its limits rather than
guessing.

## Fidelity

| Format | Real MarkItDown | Built-in fallback |
| --- | --- | --- |
| PDF | full layout extraction | not supported — says so, names the fix |
| Word `.docx` | full | headings, paragraphs, lists, tables |
| Excel `.xlsx` | full | sheets, shared strings, numbers, tables |
| PowerPoint `.pptx` | full | slide-by-slide text |
| HTML / `.epub` | full | headings, lists, links, tables, code |
| CSV / TSV / JSON / XML | full | tables / fenced JSON / flattened text |
| Jupyter `.ipynb` | full | markdown and code cells |
| Images, audio, YouTube | OCR and transcription | not supported |
| Plain text and code | passthrough | passthrough |

The built-in converter is a safety net, not a replacement. When it is used, the result
says so and names the command that unlocks full fidelity.

## Install

### From GitHub

```sh
dsh plugin --profile web add github:jiekesu967/dsh-markitdown
```

The compiled `lib/` is committed, so this path needs no build step.

### From a release tarball

Download `dsh-markitdown-<version>.tgz` from
[Releases](https://github.com/jiekesu967/dsh-markitdown/releases), then:

```sh
dsh plugin --profile web add ./dsh-markitdown-0.1.0.tgz
```

### From npm

```sh
dsh plugin --profile web add dsh-markitdown
```

Not published to npm yet — until it is, use one of the two installs above.

Then restart `dsh web`. The `markitdown` tool appears in the next session.

Nothing else is required. For PDF, OCR, audio, and full-fidelity Office conversion, install
one of:

```sh
pip install "markitdown[all]"     # or
winget install astral-sh.uv       # then `uvx markitdown` works with no install
```

## Configuration

Every field is optional; defaults are shown.

```yaml
- id: markitdown
  name: dsh-markitdown
  config:
    engine: auto              # auto | markitdown | uvx | python | builtin
    uvxPackage: "markitdown[all]"   # slim it to "markitdown[pdf,docx,pptx,xlsx]"
    command: ""               # explicit markitdown executable, overrides PATH
    timeoutMs: 120000         # per-conversion deadline
    maxChars: 120000          # inline result cap; longer output is truncated
    maxBytes: 67108864        # bytes the built-in engine will read
    allowUrls: true           # accept http(s) inputs
    extraArgs: []             # extra CLI arguments for the external engine
```

`engine: auto` probes the chain once per plugin instance and caches the winner. Setting an
engine explicitly disables the fallback: if you ask for `uvx` and there is no `uv`, the call
fails with the reason and the fix, rather than quietly converting with something else.

A first `uvx` run downloads MarkItDown and its dependencies (about a minute). Package-manager
progress lines are filtered out of the tool result; only real diagnostics are reported.

## Behaviour worth knowing

- **Relative paths resolve against the session workspace**, exactly like the built-in file
  tools, not the harness process working directory.
- **`output` writes through the filesystem seam**, so the per-session sandbox policy and the
  read-before-write observation rule both apply. Writing to an existing file re-reads it first.
- **A missing input fails before any subprocess starts**, with one clear sentence instead of an
  engine traceback.
- **Truncation is announced.** If the Markdown exceeds `maxChars` and no `output` path was
  given, the result says it was truncated and how to get the rest.
- **Subprocesses are launched with `shell: false`.** A filename or URL containing shell
  metacharacters is one argv element and can never become a command. Only real executables are
  accepted; `.cmd`/`.bat` shims are rejected because running them would require a shell.
- MarkItDown performs I/O with the privileges of the current process. Treat untrusted input
  accordingly, and see MarkItDown's own security guidance.

## Development

```sh
bash scripts/build.sh      # compile src/ → lib/
npm test                   # built-in converter + plugin surface tests
```

The build resolves DSH packages from `$DSH_CHECKOUT` (a source checkout) or from an installed
runtime via `$DSH_RUNTIME`; it links, compiles with the checkout's or a downloaded `tsc`, and
writes `lib/`. Tests need no network, no Python, and no MarkItDown install — the fallback
engine is tested against synthetic OOXML fixtures built in-process.

```
src/index.ts     plugin wiring: config, tool definition, execute path
src/engine.ts    engine chain: probe, cache, launch
src/builtin.ts   dependency-free converters
src/text.ts      entity decoding, HTML→Markdown, delimited parsing
src/zip.ts       minimal ZIP reader for OOXML/EPUB containers
src/exec.ts      subprocess plumbing with honest failure reporting
```

### Releasing

```sh
bash scripts/build.sh
npm test
npm pack
GH_PAT=<token with repo scope> npm run release
```

`scripts/release.mjs` creates the GitHub Release for the version in `package.json`, attaches the
packed tarball, and applies repository topics. It is idempotent — re-running replaces the asset on
the existing release. Both `owner/repo` (read from `.git/config`) and the token (read from the
environment) are supplied at runtime, so neither is hard-coded and the token never reaches a file.

## Credits

MarkItDown is Microsoft's work, MIT licensed: <https://github.com/microsoft/markitdown>.
This plugin only drives it. Trademarks belong to their owners; this project is not affiliated
with or endorsed by Microsoft.

## License

MIT — see [LICENSE](LICENSE).
