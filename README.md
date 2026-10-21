# 枝间 · Branch Local

**从 AI 回复中的一句话，展开一条新的思路。**

枝间是一款桌面 AI 分支对话应用。你可以围绕同一个问题开出多条独立讨论，在画布中查看它们的关系，再比较不同思路、核对依据，整理成可回看的结论。

支持 Windows、macOS Apple Silicon 和 Linux。对话保存在本机，模型由你自己的 Ollama 或兼容 OpenAI 的 API 提供。

[下载桌面版](https://github.com/sinpangky/branch-local/releases/latest) · [使用指南](docs/USER_GUIDE.md) · [反馈问题](https://github.com/sinpangky/branch-local/issues)

## 可以用来做什么

- **沿着一个问题深入追问**：选中回复中的文字创建分支，继续讨论细节，同时保留原来的主线。
- **比较不同方案**：把不同解法放进独立分支，比较共识、分歧和依据，再决定采用什么。
- **结合自己的资料讨论**：导入 Markdown、TXT 或文字型 PDF，围绕材料提问，查看来源与 PDF 页码。
- **把讨论整理成结论**：保存带来源的结论卡，标记自己验证或采用的内容，导出 Markdown。
- **找回之前的思路**：用分支目录、全文搜索、会话总结和“研究进展”继续尚未完成的讨论。

例如，讨论“怎样实现一个搜索功能”时，可以分别展开“关键词检索”“向量检索”和“如何评估效果”三个分支。每条分支保留创建时的背景，彼此的后续追问不会混在一起；需要汇总时，再选择这些分支进行比较或合并。

## 下载与安装

前往 [GitHub Releases](https://github.com/sinpangky/branch-local/releases/latest) 下载。**桌面版已包含运行环境，无需安装 Node.js，也无需手动启动本地网页服务。**

当前版本：**1.5.1**。

| 系统 | 下载 | 使用方式 |
| --- | --- | --- |
| Windows x64 | [安装版](https://github.com/sinpangky/branch-local/releases/download/v1.5.1/BranchLocal-1.5.1-x64-Setup.exe) / [免安装版](https://github.com/sinpangky/branch-local/releases/download/v1.5.1/BranchLocal-1.5.1-Portable.exe) | 运行安装程序，或直接双击免安装版 |
| macOS Apple Silicon | [DMG](https://github.com/sinpangky/branch-local/releases/download/v1.5.1/BranchLocal-1.5.1-mac-arm64.dmg) / [ZIP](https://github.com/sinpangky/branch-local/releases/download/v1.5.1/BranchLocal-1.5.1-mac-arm64.zip) | 将“枝间.app”放入 Applications |
| Ubuntu / Debian x64 | [DEB](https://github.com/sinpangky/branch-local/releases/download/v1.5.1/BranchLocal-1.5.1-linux-amd64.deb) | 在下载目录运行 `sudo apt install ./BranchLocal-1.5.1-linux-amd64.deb` |
| Fedora 等 RPM 发行版 x64 | [RPM](https://github.com/sinpangky/branch-local/releases/download/v1.5.1/BranchLocal-1.5.1-linux-x86_64.rpm) | 在下载目录运行 `sudo dnf install ./BranchLocal-1.5.1-linux-x86_64.rpm` |
| 其他 Linux x64 桌面 | [AppImage](https://github.com/sinpangky/branch-local/releases/download/v1.5.1/BranchLocal-1.5.1-linux-x86_64.AppImage) / [tar.gz](https://github.com/sinpangky/branch-local/releases/download/v1.5.1/BranchLocal-1.5.1-linux-x64.tar.gz) | AppImage 赋予执行权限后启动；tar.gz 解压后运行 `branch-local`，保留完整目录 |

安装前请留意：

- **Windows**：当前安装包未配置代码签名，系统可能显示发布者提示。
- **macOS**：当前仅提供 Apple Silicon（M 系列）版本，使用 ad hoc 签名，未经 Apple 公证。首次打开可能需要在“System Settings → Privacy & Security”中选择“Open Anyway”。
- **Linux**：需要桌面环境，以及已安装并解锁的 GNOME Keyring 或 KWallet。Ubuntu 24.04 等限制用户命名空间的系统优先使用 DEB；请以普通用户启动应用，并保留默认 sandbox。各发行版的依赖和安装体验可能不同。

需要核对文件完整性时，下载 [SHA256 校验文件](https://github.com/sinpangky/branch-local/releases/download/v1.5.1/SHA256SUMS-1.5.1.txt)，使用 `Get-FileHash`、`shasum -a 256` 或 `sha256sum` 对照检查。

## 第一次使用

1. 打开枝间，进入 **设置 → 模型连接**。
2. 选择本机 Ollama 或填写兼容 API 的连接信息，按下面的说明保存设置。
3. 新建会话并发送一个问题，确认模型可以正常回答。
4. 选中回复中的一句话，点击 **从选中文字分支**，沿着这句话继续追问。

欢迎画布中的内容是静态演示；连接模型后，才会生成真实回答。不配置模型也可在 **研究进展 → 离线体验完整流程** 中体验分支比较与结论保存，示例内容会明确标记为演示。

### 使用本机 Ollama

先安装 [Ollama](https://ollama.com/) 并下载适合自己硬件的模型。例如，下面的模型名称与应用默认配置一致，并非所有电脑都适合运行：

```sh
ollama pull qwen3:8b
```

在 **设置 → 模型连接** 选择“本机 Ollama”：

| 设置 | 填写内容 |
| --- | --- |
| API Base URL | `http://127.0.0.1:11434/v1` |
| 模型名称 | `qwen3:8b`，或已经下载的模型名 |
| API Key | 留空 |

点击 **保存设置并读取模型**，选择模型后保存。若 Ollama 服务尚未启动，可运行 `ollama serve`；已运行时无需重复启动。模型下载完成后，本机对话可以离线使用。

### 使用兼容 OpenAI 的 API

在 **设置 → 模型连接** 中填写服务提供方的 **API Base URL、模型名称和 API Key**。地址通常填写到 `/v1`，不要附加 `/chat/completions`；具体地址以提供方说明为准。

点击 **保存设置并读取模型**。如果提供方不支持读取模型列表，可以手动填写模型名称并保存，再发送一条消息验证。枝间目前不支持通过 ChatGPT 订阅账号直接登录使用模型。

使用远程服务会产生提供方规定的 API 费用。自动总结也会单独调用模型，可在 **设置 → 生成与总结** 中关闭。

## 日常使用

### 分支讨论，保留主线

在消息中选中文字，选择 **从选中文字分支**；也可以使用消息下方的 **从这里分支**。新分支保留截至该消息的上下文，之后修改父对话或继续追问，不会改动已经创建的分支背景。

点击分支中的来源链接，可以回到父对话中的对应位置。在画布上拖动卡片整理思路，使用左侧目录切换分支；讨论较多时，可以折叠分支、自动排列或搜索历史内容。需要把讨论汇到一起时，可以合并成新会话，或追加到已有主干会话。

### 比较思路，留下结论

点击 **比较分支**，选择至少两段讨论。模型会整理共识、分歧、依据和待解决的问题；展开依据可以查看引文并回到来源消息。

核对并编辑比较结果，勾选 **我已验证** 或 **我决定采用**，保存为结论卡。结论卡可以继续讨论，也能导出 Markdown。引用帮助你找回讨论依据，内容是否正确仍需自己核实。

### 带着资料提问

点击输入框附近的 **添加资料**，导入 Markdown、TXT 或可提取文字的 PDF。应用在本机提取文字，PDF 材料保留页码；原文件不会复制到工作区。

扫描件 PDF 暂不支持 OCR。导入公式、表格或排版复杂的 PDF 后，请对照原文件检查提取结果。需要控制下一次回答的背景时，可在输入框工具栏选择 **完整历史、关键结论或指定消息**，并预览发送内容。

### 可选：让 Agent 操作本地文件

需要整理文档、修改代码或运行验证时，进入 **设置 → Agent**，启用并选择工作目录，再在输入框的“执行方式”中选择 **Agent**。所用模型需支持工具调用；默认仍是直接聊天。

Agent 可以读取和搜索文本文件、创建目录、写入或编辑文件。命令和联网工具默认关闭，按需开启。写文件、建目录、运行命令和下载前，都会展示具体操作，等待你允许；执行记录会保存在会话中。网页搜索还需配置支持 JSON 的 SearXNG 服务。

**批准的命令具有当前用户权限，工作目录不是系统沙箱；不同会话分支也共享这个目录。** 操作重要文件前请备份或使用版本管理。更多权限与使用限制见 [Agent 说明](docs/USER_GUIDE.md#agent-操作与权限)。

## 数据、隐私与备份

- **对话保存在本机**：在 **设置 → 本地数据** 中打开或更改数据目录。应用不会自动把工作区同步到其他设备。
- **远程模型需要接收内容**：使用远程 API 时，当前请求所需的对话和资料会发送给所配置的服务。本地保存数据不代表远程推理时内容仍留在本机。
- **导入资料不会立即发送给模型**：本地资料默认不参与自动摘要；主动提问、比较或手动总结时，相关内容才会交给配置的模型。可在设置中调整自动摘要行为。
- **密钥可选择记住**：默认仅在本次运行中保留；勾选“在此电脑记住密钥”后，桌面版使用系统密钥存储加密保存。
- **重要内容请主动导出**：导出工作区 JSON 可用于备份和迁移，导出会话 Markdown 便于阅读与分享。导出不包含应用保存的 API Key 或连接设置，但包含对话和已导入的资料文字。

安装版和免安装版默认共享本机数据目录，卸载应用不会主动删除对话。自动备份只保留上一次保存前的工作区，不能代替定期导出。

## 常用快捷键

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+N` | 新建会话 |
| `Ctrl+Shift+B` | 从当前会话创建分支 |
| `Ctrl+K` | 搜索全部会话 |
| `Ctrl+0` | 适应整个画布 |
| `Ctrl+,` | 打开设置 |
| `Ctrl+Shift+X` | 导出当前会话为 Markdown |
| `Ctrl+Shift+S` | 导出工作区 |
| `F1` | 打开使用帮助 |

可在 **设置 → 快捷键** 中查看和修改。macOS 中这些应用快捷键目前也使用 `Ctrl`；`Command+Q` 可退出应用。发送与换行方式、主题、字号和行距均可在设置中调整。

## 遇到问题

**无法连接模型？** 先确认 Ollama 或 API 服务可用，再检查 Base URL、模型名称和密钥。能读取模型列表表示列表接口可用，仍需发送消息确认回答功能。

**Linux 提示系统密钥存储不可用？** 确认 GNOME Keyring 或 KWallet 已安装，并在当前桌面会话中解锁。枝间不会改用明文密钥存储启动。

**换电脑后如何继续使用？** 在原电脑导出工作区 JSON，再在新电脑导入。导入会作为新画布加入，不覆盖已有画布；模型连接和密钥需要重新配置。

**哪些能力暂不支持？** 当前不支持扫描 PDF 的 OCR、向模型发送图片像素、多人协作或工作区云同步。Agent 的网页读取只处理静态文字，不提供浏览器登录与点击操作。

如需反馈，请在 [Issues](https://github.com/sinpangky/branch-local/issues) 中附上系统版本、应用版本、复现步骤和报错内容。请勿上传 API Key 或含私人对话的完整工作区。

## 更多说明

- [详细使用指南](docs/USER_GUIDE.md)：上下文继承、材料限制、比较与结论、完整快捷键、Agent 权限和数据位置。
- [源码开发与发布](docs/DEVELOPMENT.md)：从源码启动、测试、跨平台打包和 GitHub Actions。
- [MIT 许可证](LICENSE)。
