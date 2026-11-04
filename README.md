# dsh-markitdown

[![npm](https://img.shields.io/npm/v/dsh-markitdown)](https://www.npmjs.com/package/dsh-markitdown)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![stars](https://img.shields.io/github/stars/jiekesu967/dsh-markitdown)](https://github.com/jiekesu967/dsh-markitdown)

[English](README.en.md) | 中文

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

### 版本要求

需要 DeepSeek Harness `0.1.5-rc.1` 或更新，**0.1.x 与 0.2.x 两条发布线都支持**：

```jsonc
"engines": { "dsh": ">=0.1.5-rc.1 <0.3.0-0" }
```

已在 `0.1.5-rc.2`、`0.2.0-rc.2`、`0.2.1-rc.5` 与 `0.2.2-alpha.2` 上验证：每条线上构建、类型检查与
测试套件均通过；并且在 `0.2.1-rc.5` 上从真实 profile 完成了一次挂载，`markitdown` 工具成功注册并
转换了文件。0.2 线把 harness 自身的 schemastery 依赖提到 `~3.18.4`（0.2.1 为 `~3.18.5`）、cordis
提到 `~4.0.4`（0.2.1 为 `~4.0.5`），但都没有触及本插件——本插件只绑定 `tools.register` 与
schemastery DSL，上述版本上的编译产物完全一致。

该范围有意允许预发布版本：DSH 会按预发布语义比较 `engines.dsh`，因此无需为每个 0.2.x 预发布版
单独收紧范围。

Node 要求 `^22.19.0 || >=24.0.0`。

下文所有安装方式都经由 `dsh plugin`，它调用 pnpm，因此请确保 `pnpm` 在 `PATH` 上
（`npm install -g pnpm`）。

### 从 GitHub 安装

```sh
dsh plugin --profile web add github:jiekesu967/dsh-markitdown
```

编译产物 `lib/` 已提交进仓库，这条路不需要任何构建步骤。

### 从 Release 压缩包安装

从 [Releases](https://github.com/jiekesu967/dsh-markitdown/releases) 下载
`dsh-markitdown-<version>.tgz`，然后：

```sh
dsh plugin --profile web add ./dsh-markitdown-<version>.tgz
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
winget install astral-sh.uv       # Windows：之后 `uvx markitdown` 免安装可用
curl -LsSf https://astral.sh/uv/install.sh | sh   # Linux / macOS
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
    env: {}                   # 传给外部引擎的额外环境变量
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

`env` 是一个"变量名 → 值"的映射，会传给外部引擎的转换进程（CLI、`uvx`、`python` 三条路径都
一样）。它叠加在插件已经传入的 UTF-8 设置（`PYTHONUTF8=1`、`PYTHONIOENCODING=utf-8`）之上，同名
键以你的值为准。它的用途是：当某个区域设置仍然弄坏输出时，可以只改配置自救，而不必去改
`node_modules` 下的文件；也可以用它给 MarkItDown 传代理或 `SSL_CERT_FILE`，而不必改变整个
harness 进程的环境。

## 值得知道的行为

- **相对路径按会话工作区解析**，与内置文件工具完全一致，而不是 harness 进程的工作目录。
- **`output` 走文件系统 seam**，因此会话级沙箱策略与"先观察后写入"规则都会生效；
  覆盖已存在的文件会先读取它。
- **输入不存在时在启动任何子进程之前就失败**，给出一句清晰的说明，而不是引擎的 traceback。
- **截断会被告知**：Markdown 超过 `maxChars` 且未给 `output` 路径时，结果里会说明被截断以及如何取全文。
- **子进程一律 `shell: false`**：含 shell 元字符的文件名或 URL 只会是一个 argv 元素，永远不可能变成命令。
  只接受真正的可执行文件；`.cmd`/`.bat` 垫片会被拒绝，因为运行它们需要 shell。
- MarkItDown 以当前进程的权限执行 I/O。请据此对待不可信输入，并参阅 MarkItDown 自身的安全说明。

## 资源限制

转换不可信文档意味着"要花多少资源"由输入决定，因此每个上限都在读取过程中生效，而不是读取完再检查：

- **本地文件**超过 `maxBytes` 即被拒绝：无论走文件系统 seam，还是不经过 seam 的兜底路径，行为一致。
  大小先由 `stat` 得到，因此小文件不会按整个上限预分配内存。
- **URL 响应**在传输过程中受限：声明的 `content-length` 一旦超过上限，就完全不下载；
  流式响应则在传输途中越过上限时立即取消。
- **压缩包条目**有解压上限，因此几 KB 的 ZIP 无法膨胀成数 GB。默认每个条目 256 MiB，
  可用 `unzip(buffer, maxEntryBytes)` 与 `convertBuiltin(bytes, name, { maxEntryBytes })` 覆盖。
- **表格单元格引用**超出 Excel 自身最后一列（`XFD`）时会被丢弃，而不是用来确定行数组大小。
- **子进程输出**有上限；因超出上限被终止的子进程会如实说明原因——而不是被报成超时，
  那样既说错了原因，也给错了解决办法。

## 开发

```sh
npm run build      # 编译 src/ → lib/
npm test           # 内置转换器 + 插件接口测试
npm run typecheck  # 只做类型检查
```

构建从 `$DSH_CHECKOUT`（源码检出）或 `$DSH_RUNTIME`（已安装运行时）解析并链接 DSH 包；两者都未
设置时会自行发现运行时——`PATH` 上的 `dsh`、当前 Node 安装的全局前缀，或 `npm root -g`——因此
直接 `npm run build` 即可。编译在单个 Node 进程内通过 TypeScript 编译器 API 完成——不依赖 shell，
Windows 上同样可用。源码未变时重新构建，`lib/` 逐字节一致。

测试不需要网络、Python 或 MarkItDown：内置引擎用进程内合成出来的 OOXML 夹具测试。
若环境不允许创建子进程，用 `npm run test:inline` 在同进程内跑完。

```
src/index.ts     插件装配：配置、工具定义、执行路径
src/engine.ts    引擎链：探测、缓存、启动
src/builtin.ts   零依赖转换器
src/text.ts      实体解码、HTML→Markdown、分隔符解析
src/zip.ts       OOXML/EPUB 用的最小 ZIP 读取器
src/exec.ts      子进程封装，失败原因如实上报
```

## 致谢

MarkItDown 是微软的作品，MIT 许可：<https://github.com/microsoft/markitdown>。
本插件只是驱动它。商标归各自所有者；本项目与微软无隶属或背书关系。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
