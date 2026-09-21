# Backspace 中文版开发交接

## 项目内容

这是 Backspace 1.3.0 的简体中文源码版本，包含网页端中文语言包、桌面端中文文案、LiveKit 语音接入和 Portainer 部署文件。

当前没有生成可交付的 Windows 安装 EXE。接手开发时从源码构建即可。

## 本地开发

环境要求：Node.js 20 或更新版本、pnpm 10、Docker（仅在构建镜像或运行服务时需要）。

```bash
pnpm install
pnpm typecheck
pnpm build
```

网页端和服务端分别运行：

```bash
pnpm dev:web
pnpm dev:server
```

桌面端构建：

```bash
pnpm --filter @backspace/desktop build
```

Windows 桌面端需要 Visual Studio C++ Build Tools 才能完整构建 `uiohook-napi` 原生模块。

## 中文本地化

- 正式网页语言包：`packages/web/src/locales/zh/`
- 桌面端文案：`packages/desktop/src/l10n.ts`
- 校对稿：`translation-draft/zh/`
- 合并校对稿：`node scripts/merge-zh-draft.mjs`
- 检查语言包：`node scripts/check-i18n.mjs`

当前网页客户端只有深色主题；“设备外观”设置目前提供语言和界面缩放，没有浅色或跟随系统模式。

## 部署约定

Portainer Compose 在 `deploy/portainer-compose.yml`，不包含 Caddy 或其他反向代理。Lucky 使用两个域名规则：

```text
chat.example.com  -> http://服务器IP:3000
voice.example.com -> http://服务器IP:7880
```

环境变量示例：

```text
DOMAIN=chat.example.com:2096
APP_PORT=3000
LIVEKIT_URL=wss://voice.example.com:2096
LIVEKIT_TURN_DOMAIN=voice.example.com
JWT_SECRET=随机密钥
LIVEKIT_API_KEY=API加随机字符
LIVEKIT_API_SECRET=随机密钥
```

当前 LiveKit 使用单个 WebRTC UDP 复用端口：

```yaml
rtc:
  tcp_port: 7881
  udp_port: 7882
```

启用 TURN 时还配置 `3478/UDP` 和 `30000-30010/UDP`。如果确认所有用户都能直连，可关闭 TURN，并只保留 `7882/UDP` 和 `7881/TCP`。

## 安全注意

交接包不包含 `.env`、JWT/API 密钥、数据库、上传文件、Docker 镜像或 `node_modules`。不要把真实密钥提交到 GitHub。首个注册账号是实例管理员。

## 验证

```bash
node scripts/check-i18n.mjs
docker compose config
```

语音连接失败时先检查 LiveKit 日志中的 `rtc.portUDP`，再确认公网 `7882/UDP` 已转发到 Docker 主机。LiveKit 使用 `network_mode: host`，不需要在 Compose 中额外添加媒体端口映射。
