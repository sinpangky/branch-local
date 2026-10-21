# 开发与发布

[返回项目首页](../README.md)

以下内容面向源码开发者；直接使用桌面版无需执行这些命令。

## GitHub Actions 与发布

`CI` 在推送 `main`、向 `main` 提交 PR 或手动运行时，分别在 Windows、Apple Silicon Mac 和 Linux 上安装锁定依赖、运行单元测试并构建前端。

`Release` 在推送 `v*` 标签时自动运行，也可从 Actions 页面手动选择已存在的版本标签重试。标签必须与该标签下 `package.json` 的版本一致。三个平台分别完成测试、打包和真实打包应用的桌面启动检查后，汇集 8 个安装包，生成 SHA256 校验文件，上传到草稿 Release，全部上传成功后才公开发布。Linux 的自动化桌面检查使用 Xvfb、临时 keyring 和启用的 Chromium sandbox；不会安装 DEB/RPM 到构建机。

发布新版本时，先同步修改 `package.json` 与 `package-lock.json` 的版本并提交，再推送对应标签，例如：

```powershell
git tag -a v1.6.0 -m "Release v1.6.0"
git push origin v1.6.0
```

工作流只在最终发布任务授予 `contents: write`，使用 GitHub 自动提供的 `GITHUB_TOKEN`，无需另存 PAT。已公开的 Release 不会被自动覆盖；失败留下的草稿可以重试。Windows 未配置发行证书；macOS 沿用 ad hoc 签名，未公证。

## 本地开发

源码开发需要 Node.js 22.13 或更新版本：

```powershell
npm ci --include=optional
npm start
```

也可双击 `start-desktop.cmd`：有展开版时直接打开，否则从源码构建桌面版。

```powershell
npm test
npm run test:desktop
npm run dist:win
npm run dist:mac
npm run dist:linux
npm run release:checksums
```

`npm run test:desktop` 在独立临时数据目录中隐藏启动应用，检查 React 工作区、受限 preload、加密存储及关闭前保存，不操作用户窗口。模型测试使用模拟服务，不发送真实外部 AI 请求。

三个 `dist:*` 命令分别在 Windows、Apple Silicon Mac 和 Linux 构建机上运行；只运行所在平台对应的一条。`npm run dist` 也可按当前平台的默认目标打包。所有命令都设置 `--publish never`，不会自动发布到外部服务。Windows 生成 x64 NSIS 安装版及免安装版；Mac 生成 arm64 DMG 和 ZIP；Linux 生成 x64 DEB、RPM、AppImage 和 tar.gz。

构建机使用 `npm ci --include=optional` 安装锁定依赖；PDF 提取依赖 `@napi-rs/canvas` 原生模块，不能把 Windows 的 `node_modules` 复制到 Mac/Linux。Mac 需要 Xcode Command Line Tools，Linux 的 RPM 构建需要 `rpmbuild`。不要跳过可选依赖。图标已经包含在 `build/`；修改图标后，可用安装了 Pillow 的 Python 运行 `python scripts/make-icon.py` 同步生成 PNG、ICO 和 ICNS。

低内存 Linux 构建机可使用 `ELECTRON_BUILDER_COMPRESSION_LEVEL=6 npm run dist:linux -- --config.rpm.compression=gzip`，降低 tar.gz 和 RPM 压缩所需的资源；发布工作流使用这一设置。AppImage 使用固定的 static runtime 1.0.3，并通过 `build/after-pack.mjs` 保留默认 sandbox，不使用打包器自动添加的 `--no-sandbox`。

各平台都应执行单元测试，并用 `node scripts/desktop-smoke.mjs <打包后的可执行文件>` 检查真实包的 React 工作区、PDF 导入、系统密钥存储及退出保存。Mac 的可执行文件位于 `release/mac-arm64/枝间.app/Contents/MacOS/枝间`；Linux 位于 `release/linux-unpacked/branch-local`。Linux GUI 检查需要显示服务、系统密钥存储和可用的 Chromium sandbox。完成后将安装包汇集到 `release/`，运行 `npm run release:checksums` 生成校验文件。

当前未配置发行用代码签名证书；Mac 配置中的 `identity: "-"` 表示 ad hoc 签名。正式公证发行时应改用自己的 Developer ID 和公证凭据。跨平台构建约束见 [electron-builder 官方说明](https://www.electron.build/docs/features/multi-platform-build/)。

保留的网页开发模式为 `npm run dev`；`npm run web` 可启动旧式网页服务。它们只是开发选项，桌面版不依赖它们。桌面数据目录可通过 `BRANCH_LOCAL_USER_DATA` 指定。

目前支持本地文字型材料和可追溯结论；尚未实现扫描 PDF OCR、网页抓取、多人协作和云同步。

## 模型请求与缓存

本地 fork 保存对话历史，并不复制模型服务器的 KV cache。新分支保持原始角色、消息顺序和文本前缀，选中内容的聚焦提示放入分支第一条新问题；普通对话请求不会加入动态分支树、邻居总结等资料。旧版已保存的聚焦提示保持原语义，以免改变既有会话。

整表按钮建立的新分支以表格序号和首行短摘录聚焦，完整表格仍只存在于继承历史；界面保留完整引用用于原文定位。手动选中的局部文字保留精确引用。

当前使用无状态 Chat Completions 接口，仍需发送完整历史。相同前缀可以让支持缓存的服务器复用已有 KV，减少重复预填充计算；能否命中受模型、模板、路由、缓存保留和服务端配置影响。缓存不等于输入 tokens 为零，也不保证免费。两个分叉后的 KV 不能直接拼接，另一分支追加的差异仍需要作为新输入处理；保留主干前缀可避免重写主干历史。

自动总结是独立的模型请求；可在设置中关闭。用量中未知的缓存数量不会推断成零或命中。兼容网关、Ollama、vLLM 的实际缓存能力与计费以各自服务为准，应用不会强行加入不受支持的会话参数。

参考：[OpenAI Prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching)、[OpenAI Conversation state](https://developers.openai.com/api/docs/guides/conversation-state)、[vLLM Automatic Prefix Caching](https://docs.vllm.ai/en/latest/features/automatic_prefix_caching/)。
