# dsh-markitdown

[![npm](https://img.shields.io/npm/v/dsh-markitdown)](https://www.npmjs.com/package/dsh-markitdown)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/jiekesu967/dsh-markitdown)](https://github.com/jiekesu967/dsh-markitdown)

[English](README.md) | 中文

把 [Microsoft MarkItDown](https://github.com/microsoft/markitdown) 包装成 DeepSeek Harness 的模型工具。
一个工具 `markitdown`，把文档变成模型真正读得懂的 Markdown。

模型在读取任何非文本文件之前调用它：

```
markitdown({ input: "reports/q3.pdf" })
markitdown({ input: "data/forecast.xlsx", output: "notes/forecast.md" })
markitdown({ input: "https://example.com/spec.html" })
```

## 为什么做这个

纯文本模型打不开 PDF、表格和幻灯片。MarkItDown 把这件事做得很好——但它是 Python 包，
而一个 harness 插件不能假定某种 Python 环境、某种安装布局，更不能假定机器上装了什么。

所以本插件既不重新实现 MarkItDown，也不内嵌它：它**查找真实的安装并驱动它**，
找不到时退回一个自带的内置转换器。

| 顺序 | 引擎 | 是什么 | 需要 |
| --- | --- | --- | --- |
| 1 | `markitdown` | 微软官方 CLI | `pip install "markitdown[all]"` |
| 2 | `uvx markitdown` | 免安装直接跑真包 | [uv](https://docs.astral.sh/uv/) |
| 3 | `python -m markitdown` | 已装该包的 Python | Python 3.10+ 且装了 MarkItDown |
| 4 | built-in | 插件自带的零依赖转换器 | 什么都不需要 |

顺序 2 通常最划算：机器上有 `uv`，就能跑**真正的** MarkItDown 且无需永久安装。
它默认使用 `markitdown[all]`，否则 Office 和 PDF 格式根本无法转换——裸的 `markitdown`
并不包含任何格式转换器。

顺序 4 让工具在什么都没装的机器上依然可用；它老实说明自己的能力边界，而不是瞎猜。

## 保真度

| 格式 | 真 MarkItDown | 内置兜底 |
| --- | --- | --- |
| PDF | 完整版面提取 | 不支持——明确说明并给出解决办法 |
| Word `.docx` | 完整 | 标题、段落、列表、表格 |
| Excel `.xlsx` | 完整 | 工作表、共享字符串、数字、表格 |
| PowerPoint `.pptx` | 完整 | 逐页文本 |
| HTML / `.epub` | 完整 | 标题、列表、链接、表格、代码 |
| CSV / TSV / JSON / XML | 完整 | 表格 / 代码块 JSON / 展平文本 |
| Jupyter `.ipynb` | 完整 | Markdown 与代码单元 |
| 图片、音频、YouTube | OCR 与转写 | 不支持 |
| 纯文本与代码 | 原样透传 | 原样透传 |

内置转换器是安全带，不是替代品。一旦用到它，结果里会写明，并给出解锁完整保真度的命令。

## 安装

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:jiekesu967/dsh-markitdown
```

编译产物 `lib/` 已提交进仓库，这条路不需要任何构建步骤。

### 从 Release 压缩包安装

从 [Releases](https://github.com/jiekesu967/dsh-markitdown/releases) 下载
`dsh-markitdown-<version>.tgz`，然后：

```sh
dsh plugin --profile web add ./dsh-markitdown-0.1.0.tgz
```

### 从 npm 安装

```sh
dsh plugin --profile web add dsh-markitdown
```

npm 包由本仓库发布：<https://www.npmjs.com/package/dsh-markitdown>。

重启 `dsh web`，`markitdown` 工具会在下一个会话中出现。

除此之外无需任何依赖。若要 PDF、OCR、音频与完整保真的 Office 转换，任选其一：

```sh
pip install "markitdown[all]"     # 或者
winget install astral-sh.uv       # 之后 `uvx markitdown` 免安装可用
```

## 配置

所有字段均可选，下面是默认值。

```yaml
- id: markitdown
  name: dsh-markitdown
  config:
    engine: auto              # auto | markitdown | uvx | python | builtin
    uvxPackage: "markitdown[all]"   # 可精简为 "markitdown[pdf,docx,pptx,xlsx]"
    command: ""               # 显式指定 markitdown 可执行文件，覆盖 PATH 查找
    timeoutMs: 120000         # 单次转换超时
    maxChars: 120000          # 内联返回上限，超出则截断
    maxBytes: 67108864        # 内置引擎读取的字节上限
    allowUrls: true           # 是否接受 http(s) 输入
    extraArgs: []             # 传给外部引擎的额外命令行参数
```

`engine: auto` 每个插件实例只探测一次并缓存结果。显式指定引擎会**关闭兜底**：
如果你指定 `uvx` 而机器上没有 `uv`，调用会直接失败并说明原因与解法，
而不是悄悄换一个引擎转出别的东西。

首次 `uvx` 运行会下载 MarkItDown 及其依赖（约一分钟）。包管理器的进度输出会被过滤掉，
只有真正的诊断信息才会进入工具结果。

## 值得知道的行为

- **相对路径按会话工作区解析**，与内置文件工具完全一致，而不是 harness 进程的工作目录。
- **`output` 走文件系统 seam**，因此会话级沙箱策略与"先观察后写入"规则都会生效；
  覆盖已存在的文件会先读取它。
- **输入不存在时在启动任何子进程之前就失败**，给出一句清晰的说明，而不是引擎的 traceback。
- **截断会被告知**：Markdown 超过 `maxChars` 且未给 `output` 路径时，结果里会说明被截断以及如何取全文。
- **子进程一律 `shell: false`**：含 shell 元字符的文件名或 URL 只会是一个 argv 元素，永远不可能变成命令。
  只接受真正的可执行文件；`.cmd`/`.bat` 垫片会被拒绝，因为运行它们需要 shell。
- MarkItDown 以当前进程的权限执行 I/O。请据此对待不可信输入，并参阅 MarkItDown 自身的安全说明。

## 开发

```sh
npm run build      # 编译 src/ → lib/
npm test           # 内置转换器 + 插件接口测试
npm run typecheck  # 只做类型检查
```

构建从 `$DSH_CHECKOUT`（源码检出）或 `$DSH_RUNTIME`（已安装运行时）解析 DSH 包，
链接进 `node_modules`，然后**在单个 Node 进程内**通过 TypeScript 编译器 API 完成编译——
不依赖 shell、不创建子进程，因此在 Windows 以及受限环境里同样可用。
`scripts/build.sh` 只是给需要 shell 入口的调用方准备的一层包装。
构建是可复现的：源码未变时重新构建，`lib/` 逐字节一致。

测试不需要网络、Python 或 MarkItDown：内置引擎用进程内合成出来的 OOXML 夹具测试。
每个测试文件默认各起一个进程；若环境不允许创建子进程，用 `npm run test:inline` 在同进程内跑完。

```
src/index.ts     插件装配：配置、工具定义、执行路径
src/engine.ts    引擎链：探测、缓存、启动
src/builtin.ts   零依赖转换器
src/text.ts      实体解码、HTML→Markdown、分隔符解析
src/zip.ts       OOXML/EPUB 用的最小 ZIP 读取器
src/exec.ts      子进程封装，失败原因如实上报
```

### 发布

```sh
npm run build
npm test
npm pack
GH_PAT=<具有 repo 权限的 token> npm run release
npm publish
```

`scripts/release.mjs` 会按 `package.json` 里的版本创建 GitHub Release、附上打包好的 tgz，
并设置仓库 topics。它是幂等的——重复执行只会替换已有 Release 上的附件。
`owner/repo`（从 `.git/config` 读取）与 token（从环境变量读取）都在运行时提供，
因此二者都不硬编码，token 也不会落到任何文件里。

如果仓库 remote 配的是 SSH，那么推送这一步完全不需要任何 GitHub token。

## 致谢

MarkItDown 是微软的作品，MIT 许可：<https://github.com/microsoft/markitdown>。
本插件只是驱动它。商标归各自所有者；本项目与微软无隶属或背书关系。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
