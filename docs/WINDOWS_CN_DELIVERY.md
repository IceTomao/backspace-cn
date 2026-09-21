# Backspace Windows 中文客户端 1.3.2

## 安装与使用

- 安装文件：`Backspace-CN-1.3.2-win-x64.exe`，适用于 Windows x64。
- 默认连接：`https://chat.kevz.me:2096`。服务已由维护者部署，本客户端不需要启动本地服务端。
- 首次默认简体中文，之后保留手动选择的语言。使用现有 Backspace 账号登录。
- 可以通过托盘菜单切换服务器，后续启动记住已保存的地址。若设置了 `BACKSPACE_URL` 环境变量，该变量优先于已保存地址。
- 保留应用名称 Backspace 和原有用户数据目录 `%APPDATA%\Backspace`。已有官方版应先退出；本安装包沿用应用身份，不设计为与官方版并行安装。
- 此版关闭上游自动更新。升级时向维护者获取新版中文安装包。服务器提供的网页仍随服务端部署更新。
- 本包未数字签名，Windows 可能提示发布者未知或信誉不足。先核对来源及校验值，不要关闭系统安全防护。
- 语音、视频和屏幕共享依赖现有服务器的 LiveKit、网络和设备权限；安装包中不包含 JWT 或 LiveKit 服务端密钥。

## 主题切换

- 打开 **设置 → 设备外观 → 主题**，在“语言”和“界面比例”之间选择 **跟随系统 / 浅色 / 深色**。
- 也可右键 Windows 通知区域的 Backspace 图标，选择 **主题 → 跟随系统 / 浅色 / 深色**。两个入口共用同一份偏好，选择同步。
- 首次默认跟随 Windows 的“默认应用模式”，不是桌面背景或任务栏颜色。系统应用模式改变后自动切换；手动选择浅色或深色后不再跟随。
- 偏好保存在 `%APPDATA%\Backspace\theme.json`，重启或切换服务器后继续生效。配置缺失、格式错误或模式无效时回退到跟随系统；写入失败会提示并保留原来的选择。
- 主题仍由本地客户端控制。“设备外观”的主题控件由 Windows 客户端在隔离 preload 中添加，没有部署或修改线上网页。切换不刷新网页、不主动清理登录信息或重建语音连接。
- Windows 高对比度开启时不注入自定义配色。图片、头像、视频及用户自定义文字颜色不做反色。聊天中原本写死的浅色名字使用局部深色底色保证可读，保留名字本身的颜色。
- 只更新 Windows 客户端。线上网页、后端、数据库未修改；登录页仍显示服务端版本 `1.3.0 (cn-20260921)`，不代表桌面安装包版本没有升级。
- 样式按当前 Backspace 页面结构适配，服务器以后大幅更新界面时需要重新验证兼容性。第三方嵌入页面不应用本主题。

## 覆盖安装

先从托盘退出旧版，再运行 1.3.2 安装包并沿用原安装目录。不要先卸载并删除用户数据。应用身份、用户数据目录、默认中文服务器及禁用上游更新策略保持不变。

本次不安装或覆盖正在运行的客户端；覆盖安装后账号及已有设置的真实保留情况仍需人工验收。旧版 1.3.0、1.3.1 交付目录保留。

## 文件

- `Backspace-CN-1.3.2-win-x64.exe`：中文安装程序，允许选择安装位置。
- `Backspace-CN-1.3.2-source.zip`：本次修改对应的完整工作区源码快照，包含许可证和构建脚本，不包含运行密钥、用户数据和依赖目录。
- `SHA256SUMS.txt`：安装包、源码包及本说明的 SHA-256。

可用 PowerShell 的 `Get-FileHash -Algorithm SHA256` 检查文件。

## 本轮交付（1.3.2，2026-09-21）

按用户要求，本轮仅修改、构建和打包，不运行单元测试、渲染测试、界面验证或安装包复验，实际验收由用户完成。构建过程保留既有安全配置，源码归档仍使用隐私文件排除规则。下面的测试记录仅适用于此前 1.3.1，不代表新增设置入口已经通过验证。

新增入口需重点检查：打开/关闭设备外观后正常显示、三种模式切换、与托盘双向同步、重启保留偏好、切换语言和界面比例后仍可使用。

## 上轮验证（1.3.1，2026-09-21）

- 桌面 TypeScript 构建、15 个测试文件的 213 项测试、语言完整性检查通过。
- 单元测试覆盖配置缺失/损坏、保存及原子替换失败、重启恢复、手动模式优先、模拟系统变化、事件监听清理、托盘单选及回调、IPC 主窗口/主框架/本地路径校验、参数拒绝、preload 初始化失败时保留原接口。
- 隔离 Electron 43.7.0 渲染测试使用真实 sandbox preload 和 CSS：首次绘制、刷新、导航、浅深切换无需页面重载、存储保留、真实 Emoji Mart Shadow DOM、Prism 风格 token、用户指定颜色和媒体过滤、子框架及未识别页面隔离均通过。
- 通过 Chromium 仅对测试渲染器模拟高对比度，确认自定义配色停止生效；没有修改 Windows 系统设置。系统主题变化的行为另以模拟事件测试。
- 使用全新测试 profile 读取线上中文登录页，无登录、注册或消息操作。已检查浅深两种登录页、内置服务器选择页、故障恢复页和组件测试页截图，并对截图背景及表情区域进行像素校验。组件测试页不等同于登录后真实页面验收。
- Windows x64 原生键盘钩子沿用已验证的 Electron 43.7.0 预编译模块；最终包内二进制与已验证依赖一致。
- 打包检查核对主题管理模块、preload、CSS 内容及应用版本，确认无 `.env`、数据库、测试脚本和上游更新配置；窗口图标和 Windows 原生模块齐全。
- Electron 的 RunAsNode 和命令行 Node 调试已关闭，OnlyLoadAppFromAsar 已开启。

待人工验收：

- 1.3.2 全新安装与覆盖安装、实际账号和已有语言/服务器设置保留、设置和托盘主题菜单点击及正常退出重启。
- 在 Windows 设置中切换“默认应用模式”，确认跟随系统实时响应；手动浅色/深色保持不变。
- 使用现有账号检查聊天、频道和成员列表、设置、弹窗、表情和代码块的两种主题，以及实际服务器切换/不可达恢复、首次启动和跨页面导航是否有明显闪烁。
- 保持语音连接时切换主题，确认连接不中断；联调收发消息、语音、视频和屏幕共享。没有用接口可访问性替代这些功能验收。

测试截图来自隔离 Electron 渲染器，非安装后原生窗口截图；本机原生窗口截图/点击工具此前存在接口限制。测试未接触真实账号，不声明登录后页面已完成视觉验收。

## 源码构建

使用 Node.js 24 和 pnpm 10.34.3，在源码根目录运行：

```powershell
pnpm --filter @backspace/desktop install --frozen-lockfile
pnpm --filter @backspace/desktop test
pnpm --filter @backspace/desktop build:ts
pnpm --filter @backspace/desktop exec electron scripts/theme-smoke.cjs --online
pnpm --filter @backspace/desktop exec electron-builder --win nsis --x64 --publish never '--config.electronDist=node_modules/electron/dist'
node scripts/package-windows-delivery.mjs
```

渲染测试需要安装工作区中的网页依赖（使用 Emoji Mart 真实组件），输出在 `packages/desktop/dist-electron/theme-qa`，不会读取真实用户 profile。去掉 `--online` 可只运行本地测试。

本轮跳过上述测试命令，归档使用 `node scripts/package-windows-delivery.mjs --package-only` 跳过包体复验，仅生成交付文件及 SHA-256。

本机未安装 Visual Studio。依赖安装中的原生源码重编译会报告缺少工具链，Windows x64 已通过包内预编译文件完成验证；这不代表所有架构都可以省略原生模块验证。

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
