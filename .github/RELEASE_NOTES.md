## 下载

- Windows x64：`Setup.exe` 为安装版，`Portable.exe` 为免安装版。
- macOS Apple Silicon：下载 `mac-arm64.dmg` 或 `mac-arm64.zip`。
- Linux x64：按发行版选择 `.deb`、`.rpm`，或下载 `.AppImage` / `.tar.gz`。
- `SHA256SUMS-*.txt` 包含所有安装包的 SHA256 校验值。

首次使用时，在“设置 → 模型连接”配置自己的 Ollama 或兼容 OpenAI 的 API。对话数据保存在本机。

## 系统与签名

Windows 安装包未配置代码签名。macOS 使用 ad hoc 签名，未经 Apple 公证，首次打开可能需要在“System Settings → Privacy & Security”中允许。

Linux 需要桌面环境和已解锁的 GNOME Keyring 或 KWallet。应用默认启用 Chromium sandbox；Ubuntu 24.04 等限制用户命名空间的系统优先使用 `.deb`。自动化桌面启动检查不等于已在每个发行版上验证安装。
