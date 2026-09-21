# Backspace Windows 中文客户端 1.3.0

## 安装与使用

- 安装文件：`Backspace-CN-1.3.0-win-x64.exe`，适用于 Windows x64。
- 默认连接：`https://chat.kevz.me:2096`。服务已由维护者部署，本客户端不需要启动本地服务端。
- 首次默认简体中文，之后保留手动选择的语言。使用现有 Backspace 账号登录。
- 可以通过托盘菜单切换服务器，后续启动记住已保存的地址。若设置了 `BACKSPACE_URL` 环境变量，该变量优先于已保存地址。
- 保留应用名称 Backspace 和原有用户数据目录 `%APPDATA%\Backspace`。已有官方版应先退出；本安装包沿用应用身份，不设计为与官方版并行安装。
- 此版关闭上游自动更新。升级时向维护者获取新版中文安装包。服务器提供的网页仍随服务端部署更新。
- 本包未数字签名，Windows 可能提示发布者未知或信誉不足。先核对来源及校验值，不要关闭系统安全防护。
- 语音、视频和屏幕共享依赖现有服务器的 LiveKit、网络和设备权限；安装包中不包含 JWT 或 LiveKit 服务端密钥。

## 文件

- `Backspace-CN-1.3.0-win-x64.exe`：中文安装程序，允许选择安装位置。
- `Backspace-CN-1.3.0-source.zip`：本次修改对应的完整工作区源码快照，包含许可证和构建脚本，不包含运行密钥、用户数据和依赖目录。
- `SHA256SUMS.txt`：安装包、源码包及本说明的 SHA-256。

可用 PowerShell 的 `Get-FileHash -Algorithm SHA256` 检查文件。

## 本次验证（2026-09-21）

- 桌面 TypeScript 构建、桌面测试和语言完整性检查通过。
- Windows x64 原生键盘钩子在 Electron 43.7.0 中成功加载、启动和停止；最终包内二进制与已验证文件一致。
- NSIS 安装成功；安装后的客户端已加载线上中文登录页面。指定英文启动环境时仍默认中文，重启后仍为中文。
- 模拟不可达地址时，安装后的客户端显示中文故障恢复页，没有更新操作按钮。
- 自动化测试覆盖服务器地址优先级、恢复重试、手动切换不跳回、已有语言偏好保留、存储不可用、中文键及占位符，以及恢复更新入口阻断。
- 打包检查确认无 `.env`、数据库、测试脚本和上游更新配置；窗口图标和 Windows 原生模块齐全。
- Electron 的 RunAsNode 和命令行 Node 调试已关闭，OnlyLoadAppFromAsar 已开启。

待人工验收：安装器逐页外观、服务器及语言切换的完整点击流程、托盘正常退出、用户实际登录、消息收发、语音、视频和屏幕共享。本机截图工具不支持当前窗口捕获接口，点击操作也受工具限制；以上界面文本通过 Windows 可访问性树核验，未将其作为完整视觉验收。

## 源码构建

使用 Node.js 24 和 pnpm 10.34.3，在源码根目录运行：

```powershell
pnpm --filter @backspace/desktop install --frozen-lockfile
pnpm --filter @backspace/desktop test
pnpm --filter @backspace/desktop build:ts
pnpm --filter @backspace/desktop exec electron-builder --win nsis --x64 --publish never '--config.electronDist=node_modules/electron/dist'
node scripts/package-windows-delivery.mjs
```

本机未安装 Visual Studio。依赖安装中的原生源码重编译会报告缺少工具链，本次通过包内 Windows x64 预编译文件完成验证；这不代表所有架构都可以省略原生模块验证。

如果 Electron 安装脚本尚未完成，先运行：

```powershell
node packages/desktop/node_modules/electron/install.js
```

下载受限时可使用镜像，保持默认 TLS 与校验检查，不禁用安全校验：

```powershell
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'
$env:ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/'
node packages/desktop/node_modules/electron/install.js
```

默认配置集中在 `packages/desktop/src/buildConfig.ts`。不要往这里加入服务端密钥。源码归档来自 Git 跟踪及未忽略的新文件；解压后的源码没有 Git 元数据时仍可构建安装包，重新生成交付源码归档则需要在 Git 工作区运行交付脚本。
