# Backspace 中文版交接说明

## 已完成内容

- 基于 Backspace 1.3.0 源码制作简体中文客户端。
- 网页端 16 个语言命名空间全部具备中文，共 2,074 条叶子文案。
- Electron 桌面端托盘、菜单和更新提示已汉化。
- `zh-CN` 系统语言会自动选择简体中文，也可在设置中手动切换。
- 服务端 API、数据库、认证、WebSocket 和语音协议未改动。
- 中文运行时文件位于 `packages/web/src/locales/zh/`。
- 后续校对源位于 `translation-draft/zh/`，修改后运行 `node scripts/merge-zh-draft.mjs` 合并。

## 语音和登录方式

本版本没有接入 Mumble，也不需要安装或启动 Murmur。Backspace 使用自己的网页/桌面客户端，语音、视频和屏幕共享由自部署的 LiveKit 服务提供。

用户只注册和登录一次 Backspace。进入客户端后点击语音频道即可加入，不会启动 Mumble，不会弹出第二个客户端，也不需要第二套账号。

## 在另一台电脑部署

部署主机需要 Linux、Docker、Docker Compose 和一个解析到主机的域名。解压交接包后进入项目目录：

```bash
chmod +x install.sh update.sh backup.sh restore.sh deploy.sh docker-entrypoint.sh
BACKSPACE_BUILD=true ./install.sh
```

必须保留 `BACKSPACE_BUILD=true`。默认安装器会拉取官方预构建镜像，该镜像不包含本地中文修改；此参数会用交接包中的源码构建镜像。

安装器会询问域名、部署模式和是否启用语音，并生成 `.env`、密钥和 `livekit.yaml`。不要从旧电脑复制含密钥的 `.env`；本交接包也没有包含任何运行密钥或用户数据。

Portainer 专用 Stack 不包含 Caddy 或其他反向代理。Lucky 的这个反向代理页面按域名匹配，不按 URL 路径匹配，因此使用两个域名：主站域名转发到主机 `3000/TCP`，语音子域名转发到主机 `7880/TCP`。Compose 中的 `LIVEKIT_URL` 要填语音子域名。

启用语音时还需要放行并转发：

| 端口 | 协议 | 用途 |
| --- | --- | --- |
| 3478 | UDP | TURN/NAT 穿透 |
| 7881 | TCP | WebRTC TCP 回退 |
| 7882 | UDP | WebRTC 媒体复用端口 |
| 30000-30010 | UDP | TURN 中继媒体端口（仅启用 TURN 且直连失败时使用） |

注意：隧道部署模式无法承载 WebRTC UDP，安装器会关闭语音。需要语音时使用 All-in-One 或正确配置的反向代理模式。

然后打开 Lucky 提供的 `https://你的域名` 注册账号，第一个注册的账号会成为实例管理员。

## 更新与备份

这是修改过的源码版本。以后更新上游代码时，要保留中文目录、语言配置和桌面端目录，再重新运行检查与源码构建。不要直接切回官方预构建镜像，否则中文修改会消失。

常用命令：

```bash
docker compose ps
docker compose logs -f backspace
docker compose logs -f livekit
./backup.sh
```

## 已完成验证

- `node scripts/check-i18n.mjs`：通过，无缺失键、空值、占位符或标签问题。
- 网页语言测试：15 项通过。
- 桌面语言测试：7 项通过。
- 网页 TypeScript 类型检查：通过。
- 网页生产构建：通过，并生成中文语言包。
- 桌面端 TypeScript 构建：通过。

当前电脑没有 Docker，因此没有在本机执行镜像构建和容器启动。当前电脑也没有 Visual Studio Build Tools，因此 Electron 的 `uiohook-napi` 原生模块未在本机重编译；这不影响网页端或 Docker 部署。若要在 Windows 上打包并运行桌面安装包，需要先安装 Visual Studio C++ Build Tools。

## 关键文件

- `docs/CHINESE_LOCALIZATION.md`：本地化范围和维护规则。
- `packages/web/src/i18n/languages.ts`：网页语言注册与自动检测。
- `packages/web/src/locales/zh/`：正式网页中文语言包。
- `packages/desktop/src/l10n.ts`：桌面端中文文案。
- `translation-draft/zh/`：后续人工校对源。
- `scripts/merge-zh-draft.mjs`：将校对稿合并到正式语言目录。
- `scripts/check-i18n.mjs`：完整性检查。
- `deploy/portainer-compose.yml`：可直接粘贴到 Portainer 的 Stack Compose。
- `docs/PORTAINER_DEPLOY.md`：镜像导出、导入和 Portainer 部署步骤。
