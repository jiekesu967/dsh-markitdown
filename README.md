# dsh-markitdown

[![npm](https://img.shields.io/npm/v/dsh-markitdown)](https://www.npmjs.com/package/dsh-markitdown)
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

### Requirements

DeepSeek Harness `0.1.5-rc.1` or newer on either release line — **0.1.x and 0.2.x are both
supported**:

```jsonc
"engines": { "dsh": ">=0.1.5-rc.1 <0.3.0-0" }
```

Verified against harness `0.1.5-rc.2` and `0.2.0-rc.2`. The 0.2 line moved `@deepseek-ai/dsh-tools`
to `~3.18.4` and cordis to `~4.0.4`; neither affected this plugin's code, which is why the runtime
is identical across both lines.

Node `^22.19.0 || >=24.0.0`.

### From GitHub

```sh
dsh plugin --profile web add github:jiekesu967/dsh-markitdown
```

The compiled `lib/` is committed, so this path needs no build step.

### From a release tarball

Download `dsh-markitdown-<version>.tgz` from
[Releases](https://github.com/jiekesu967/dsh-markitdown/releases), then:

```sh
dsh plugin --profile web add ./dsh-markitdown-<version>.tgz
```

### From npm

```sh
dsh plugin --profile web add dsh-markitdown
```

The package is published from this repository:
<https://www.npmjs.com/package/dsh-markitdown>.

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

## Resource limits

Converting untrusted documents means the input decides how much work the converter does, so
every cap is enforced while reading rather than after:

- **Local files** are refused above `maxBytes`, both through the filesystem seam and on the
  fallback path that runs without it. The size comes from `stat` first, so a small file never
  reserves the whole cap.
- **URL responses** are bounded during transfer: a declared `content-length` over the cap is
  refused without downloading anything, and a streamed body is cancelled mid-transfer once it
  passes the cap.
- **Archive entries** carry a decompression limit, so a few-kilobyte ZIP cannot expand into
  gigabytes. The default is 256 MiB per entry, overridable with `unzip(buffer, maxEntryBytes)`
  and `convertBuiltin(bytes, name, { maxEntryBytes })`.
- **Spreadsheet cell references** beyond Excel's own last column (`XFD`) are dropped rather than
  used to size a row array.
- **Subprocess output** is capped, and a child terminated for exceeding it says so — instead of
  being reported as a timeout, which named the wrong cause and the wrong fix.

## Development

```sh
npm run build      # compile src/ → lib/
npm test           # built-in converter + plugin surface tests
npm run typecheck  # type check only
```

The build links the DSH packages from `$DSH_CHECKOUT` (a source checkout) or `$DSH_RUNTIME` (an
installed runtime), then compiles with the TypeScript compiler API in a single Node process — no
shell, so it also runs on Windows. Rebuilding an unchanged tree leaves `lib/` byte-identical.

Tests need no network, no Python, and no MarkItDown install: the fallback engine is exercised
against synthetic OOXML fixtures built in-process. If your environment forbids spawning child
processes, `npm run test:inline` runs them all in one.

```
src/index.ts     plugin wiring: config, tool definition, execute path
src/engine.ts    engine chain: probe, cache, launch
src/builtin.ts   dependency-free converters
src/text.ts      entity decoding, HTML→Markdown, delimited parsing
src/zip.ts       minimal ZIP reader for OOXML/EPUB containers
src/exec.ts      subprocess plumbing with honest failure reporting
```

## Credits

MarkItDown is Microsoft's work, MIT licensed: <https://github.com/microsoft/markitdown>.
This plugin only drives it. Trademarks belong to their owners; this project is not affiliated
with or endorsed by Microsoft.

## License

MIT — see [LICENSE](LICENSE).
