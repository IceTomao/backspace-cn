# Portainer 部署中文版

本项目的正式镜像名是 `backspace-cn:1.3.0`。它包含已编译的简体中文网页客户端；Portainer 导入这个镜像后，Stack 不会从 GHCR 拉取上游英文镜像。

## 一、构建并导出镜像

在任意一台 Linux Docker 主机上解压源码包后执行：

```bash
chmod +x scripts/export-portainer-image.sh
./scripts/export-portainer-image.sh
```

该命令会生成 `backspace-cn_1.3.0.tar`。将此文件上传到 Portainer 的 **Images -> Import**，然后确认列表中出现 `backspace-cn:1.3.0`。

如果你在 Windows Docker Desktop 上构建，也可以在 PowerShell 执行：

```powershell
docker build --pull --tag backspace-cn:1.3.0 .
docker save --output backspace-cn_1.3.0.tar backspace-cn:1.3.0
Get-FileHash .\backspace-cn_1.3.0.tar -Algorithm SHA256
```

验证导出文件：

```bash
sha256sum backspace-cn_1.3.0.tar
```

## 二、创建 Stack

在 Portainer 中进入 **Stacks -> Add stack -> Web editor**，将 `deploy/portainer-compose.yml` 的内容完整粘贴进去。

在同一页面的 **Environment variables** 添加以下五项：

| 名称 | 值 |
| --- | --- |
| `DOMAIN` | 主站公网域名，例如 `chat.example.com:18443` |
| `APP_PORT` | 主机映射端口，默认 `3000`；Lucky 转发到 `服务器IP:APP_PORT` |
| `JWT_SECRET` | 执行 `openssl rand -hex 32` 生成的值 |
| `LIVEKIT_API_KEY` | `API` 加 16 位随机十六进制字符，例如 `APIa1b2c3d4e5f60708` |
| `LIVEKIT_API_SECRET` | 执行 `openssl rand -hex 24` 生成的值 |
| `LIVEKIT_URL` | 语音子域名，例如 `wss://voice.chat.example.com:18443` |
| `LIVEKIT_TURN_DOMAIN` | 语音子域名，不带端口，例如 `voice.chat.example.com` |

Portainer 需要 Docker Compose v2.23 或更新版本，以支持本文件中内嵌的 `configs.content` 配置。旧版本请先升级 Portainer/ Docker Engine，或者改用仓库原始的 `docker-compose.yml` 与单独的 `livekit.yaml` 文件。

不要在 Compose 中填写真实密钥，也不要把密钥提交到仓库。部署后，`backspace-data` 是持久卷，包含数据库、上传文件和备份；删除 Stack 时不要勾选删除此卷。

## 三、Lucky 转发配置

Stack 不包含 Caddy。你截图中的 Lucky 定制模式按“前端域名”匹配，不按路径匹配，因此需要两个域名规则：

| Lucky 前端域名 | 后端地址 | 说明 |
| --- | --- | --- |
| `chat.example.com` | `http://服务器IP:3000` | 网页、API、WebSocket |
| `voice.chat.example.com` | `http://服务器IP:7880` | LiveKit WebSocket 信令 |

Lucky 的前端监听端口可以使用 `2096`，两个域名共用这个 HTTPS 端口，由域名分别匹配后端。后端地址要写完整的 `http://` 地址。LiveKit 使用 host 网络。当前 Stack 使用单个 WebRTC UDP 复用端口，主机公网防火墙及路由器需要开放 `7882/UDP`、`7881/TCP`；启用 TURN 时还需要 `3478/UDP` 和 `30000-30010/UDP`。

如果 Lucky 只做普通 HTTP 隧道，文字聊天可以工作，但 WebRTC UDP 媒体流通常无法穿过隧道。

## 四、首次验证

部署完成后访问 Lucky 提供的 `https://你的域名`，注册的第一个账号就是管理员。进入任意社区的语音频道，浏览器请求麦克风权限后应能直接加入。

Stack 服务的作用：

| 服务 | 作用 |
| --- | --- |
| `backspace` | 中文网页客户端、API、文字聊天、认证、数据库，主机端口 3000 |
| `livekit` | 语音、视频和屏幕共享媒体服务，主机端口 7880/7881/7882/3478/30000-30010 |

## 更新镜像

每次修改中文源码后重新运行导出脚本，然后在 Portainer 中导入同名新镜像并重新部署 Stack。为避免同名标签缓存，推荐为每次发布增加标签，例如：

```bash
IMAGE_NAME=backspace-cn:1.3.1 ARCHIVE_PATH=./backspace-cn_1.3.1.tar ./scripts/export-portainer-image.sh
```

同时将 Stack 中的 `image: backspace-cn:1.3.0` 改为新标签。
