# 公网 IP 自动恢复：Git 构建、Portainer 拉取部署

## 先了解要更新什么

这次需要更新两个镜像：

| 镜像 | 作用 |
| --- | --- |
| `ghcr.io/icetomao/backspace-cn:latest` | 更新应用和网页客户端，让正在语音聊天的用户断线后自动重连 |
| `ghcr.io/icetomao/backspace-cn-livekit:latest` | 更新语音服务，在原容器内部检测公网 IPv4 变化，并自动重启 LiveKit 进程 |

只更新语音服务镜像，旧客户端不会获得这次新增的自动重连逻辑。因此两个镜像都要更新。

容器数量仍然是原来的两个：应用容器和语音服务容器。公网 IP 变化时，守护程序只重启语音容器内的 LiveKit 进程，应用容器继续运行。

Lucky 或路由器仍然负责 DDNS，也就是把你的域名更新到新的公网 IP。程序负责检查域名解析和恢复语音服务，不会替你修改 DDNS 设置。

## 你的部署方式：不需要操作 Linux 主机

继续使用“提交代码到 Git → GitHub Actions 构建镜像 → Portainer 拉取并更新容器”的方式即可。镜像在 GitHub 的构建机器上生成，你不需要登录自己的 Linux，也不需要导入 `.tar` 文件。

首次升级需要给两个容器补上共享卷和恢复参数。后续这些配置保留着，再按原来的方式更新镜像即可。

### 第一步：让 GitHub 构建并发布两个镜像

先把本次修改提交、推送到你要发布的 Git 分支，包括新增的 `deploy/livekit-supervisor` 目录和 `.github/workflows/docker-publish.yml`。

现有 `Publish Container Image` 工作流已新增 LiveKit 镜像发布任务。一次运行会分别构建、发布应用镜像和语音恢复镜像，支持 `linux/amd64` 和 `linux/arm64`。

这份工作流保留原来的触发方式：推送 `v*` 版本标签，或者在 GitHub 网页上手动触发。普通分支的代码推送本身不会触发这份工作流。

如果这次不准备发布新的版本标签，可以在 GitHub 仓库网页中操作：

1. 打开 `Actions`。
2. 选择 `Publish Container Image`。
3. 选择 `Run workflow`，并选中包含本次修改的分支。
4. 在额外镜像标签输入框 `tag` 中填写 `latest`。
5. 启动工作流，等 `build-and-push` 和 `build-and-push-livekit` 两个任务都成功后，再更新 Portainer。

手动运行时，如果把 `tag` 留空，不会发布新的 `latest`；所以这里需要明确填写 `latest`。应用和语音镜像使用相同的发布标签，语音镜像内部的 LiveKit 版本仍然是 `v1.13.7`。

### 第二步：在 Portainer 拉取两个镜像

按你平常拉取镜像的方式，分别拉取：

```text
ghcr.io/icetomao/backspace-cn:latest
ghcr.io/icetomao/backspace-cn-livekit:latest
```

第一次发布新的 LiveKit 镜像后，如果拉取时提示无权访问，检查这个 GitHub 镜像包的可见性，或 Portainer 的 GHCR 登录配置。新包需要具备与你拉取应用镜像相同的访问条件。

拉取新镜像后，要让容器使用它重新创建或重新部署。仅对原容器执行“重启”，不会把它换成刚拉取的新镜像。

### 第三步：首次升级补上恢复配置

根据你现在是单独管理容器，还是使用 Stack，选择下面一种做法。

#### 做法 A：你现在直接编辑、更新容器

在 Portainer 中创建一个名为 `voice-recovery` 的 Docker 卷。然后通过容器的编辑并重新部署功能，调整两个原有容器：

| 要改的项目 | 应用容器 `backspace` | 语音容器 `backspace-livekit` |
| --- | --- | --- |
| 镜像 | `ghcr.io/icetomao/backspace-cn:latest` | `ghcr.io/icetomao/backspace-cn-livekit:latest` |
| 新增卷挂载 | 将 `voice-recovery` 挂载到 `/run/backspace-voice`，设置为只读 | 将同一个 `voice-recovery` 挂载到 `/run/backspace-voice`，允许读写 |
| 新增环境变量 | `LIVEKIT_RECOVERY_STATE_PATH=/run/backspace-voice/state.json` | `LIVEKIT_RECOVERY_STATE_PATH=/run/backspace-voice/state.json` |
| 断线保留时间 | `LIVEKIT_RECONNECT_GRACE_MS=300000` | 不需要设置这一项 |

给语音容器再补上 `DOMAIN`、`LIVEKIT_URL` 和 `LIVEKIT_TURN_DOMAIN`，值与原应用配置相同，用于检查 DDNS 是否已经更新。可以保留默认公网 IP 探测地址，无需额外填写。

语音容器的启动入口使用新镜像的默认值 `/supervisor`。如果你原来的配置显式覆盖入口为 `/livekit-server`，需要移除这个覆盖，否则会绕过新增的恢复程序。启动参数和 `livekit.yaml` 挂载继续沿用原来的配置；项目提供的默认参数是 `--config /etc/livekit.yaml`。

保留原来的应用数据卷、语音配置文件、网络模式、端口和密钥。语音容器的停止等待时间建议设置为 15 秒，重启策略保持 `unless-stopped`。修改后分别重新部署两个容器。

以后更新时，以上卷和参数继续保留，只需要拉取两个新镜像并让容器使用新镜像重新创建。

#### 做法 B：你原来使用 Stack 部署

在原来的 Stack 中使用新版 `deploy/portainer-compose.yml` 更新配置。文件已将默认镜像改为上述两个 GHCR 地址，并配置好共享卷、恢复参数和停止等待时间。

继续使用原来的 Stack 名称和应用数据挂载。如果现有数据卷或宿主机目录与文件中的 `backspace-data:/app/data` 不同，保留原来的数据挂载，不要删除原有应用数据卷。

下面这些环境变量继续使用你原来的值：

| 环境变量 | 填什么 |
| --- | --- |
| `DOMAIN` | 原来的聊天网站域名，例如 `chat.example.com` |
| `LIVEKIT_URL` | 原来的语音连接地址，例如 `wss://voice.example.com:18443` |
| `JWT_SECRET` | 原来的登录密钥 |
| `LIVEKIT_API_KEY` | 原来的语音服务 API Key |
| `LIVEKIT_API_SECRET` | 原来的语音服务 API Secret |
| `LIVEKIT_TURN_DOMAIN` | 原来的 TURN 域名，例如 `chat.example.com` |

表格中的域名只是示例，不要直接照填，也不要重新生成原来的密钥。

如果你以前设置过 `BACKSPACE_IMAGE` 或 `LIVEKIT_IMAGE`，这次也要把它们改成上述 GHCR 镜像地址；没有设置过，就使用文件的默认值。

更新部署时拉取新镜像，等两个容器重新创建、启动后，再进行下面的检查。

### 第四步：确认 Lucky、DDNS 和端口转发

继续启用 Lucky 或路由器原来的 DDNS 功能。公网 IP 变化后，聊天域名、语音域名和 TURN 域名需要更新到对应的新公网地址。

Lucky 继续负责网站和语音信令的 HTTPS 转发。项目中的 Portainer 配置使用应用端口 `3000` 和 LiveKit 信令端口 `7880`；对外的域名和 HTTPS 端口继续沿用你的实际配置。

语音媒体流还需要路由器的 TCP/UDP 端口转发。按项目中的 Portainer 配置，对应端口如下：

| 协议 | 端口 | 用途 |
| --- | --- | --- |
| UDP | `7882` | 语音和视频媒体流 |
| TCP | `7881` | 媒体连接的 TCP 通道 |
| UDP | `3478` | TURN 服务 |
| UDP | `30000–30010` | TURN 中继 |

这些端口仍然转发到运行 LiveKit 的同一台内网主机。只配置 Lucky 的 HTTPS 转发，不能代替这些媒体端口转发。

保留 LiveKit 配置中的 `rtc.use_external_ip: true` 和 `logging.level: info`。新版 Portainer 文件已经包含这两项。

### 第五步：更新客户端

- 网页用户：部署完成后刷新页面，让浏览器加载新版客户端，然后重新加入语音频道。
- Electron 用户：重新加载应用中的页面，必要时关闭应用后重新打开，让它加载新版客户端。
- Android 用户：需要重新打包并安装更新后的 Android 客户端；只更新服务器不会更新手机中的原生语音恢复代码。

这里的刷新或重启是部署后加载新版代码的操作。以后公网 IP 变化时，正在语音频道里的用户应由程序自动重连，不需要再手动退出或重新加入。

## 部署后如何验证

使用两台外网设备加入同一个空间语音频道，先确认双方能互相听见。不要只在同一局域网内测试，否则不能证明公网端口转发正常。

1. 保持两台设备在频道里聊天。
2. 让路由器重新拨号，或使用其他方式实际更换公网 IPv4。
3. 等待 Lucky 或路由器的 DDNS 把域名更新到新 IP。
4. 检查用户是否在没有手动重新加入的情况下，自动回到原频道，并恢复双向语音。
5. 再测试静音用户、Android 后台通话，以及断线期间主动退出或切换频道的情况。

预期行为是：公网切换期间语音会短暂中断；网络、域名解析和服务恢复可达后，客户端自动重连，原来的静音和耳机状态继续生效。主动退出或切换频道的用户，不应被自动拉回旧频道。

恢复速度受 DDNS 更新、DNS 缓存和客户端网络状态影响。服务和客户端域名解析恢复可用后，目标是在约 60 秒内恢复语音；这个时间需要在实际部署环境验证，不能只凭容器正常运行就判断成功。

本次修改已完成静态检查。新增的 GitHub 构建流程尚未实际运行，因此不能认为镜像已经发布；还需要等待构建成功，并完成真实公网切换验收。

## 遇到问题先看哪里

在 Portainer 中查看语音容器 `backspace-livekit` 的日志：

| 日志内容 | 含义和处理方向 |
| --- | --- |
| `LiveKit advertised nodeIP=` | LiveKit 启动时采用的地址，可以用来核对是否还是旧公网 IP |
| `public IPv4 changed; refreshing LiveKit nodeIP` | 已确认公网 IP 变化，正在重启 LiveKit 进程 |
| `public IPv4 probe failed` | 获取公网 IP 失败，检查主机能否访问公网 IP 探测服务 |
| `IP recovery restart rate limit reached` | 短时间内已多次重启，触发了频率限制，检查公网是否持续变化 |

如果网站能打开，但语音一直无法恢复，重点检查 DDNS 是否已经更新、上述 TCP/UDP 端口是否仍然转发到正确的内网主机，以及两个客户端能否互相听见。

## 不使用 Portainer 时：Docker Compose 部署

这一节只供直接使用 Docker Compose 的环境参考。已经按前面的 Portainer 步骤部署，就不需要执行这里的命令。

在 Linux 主机的项目根目录配置好原来的 `.env` 和 `livekit.yaml`，并在 `.env` 中启用语音：

```dotenv
COMPOSE_PROFILES=voice
```

然后使用本次修改后的源代码构建、部署：

```sh
docker compose -f docker-compose.yml -f deploy/docker-compose.voice-recovery.yml up -d --build
```

如果你原来使用 `docker-compose.proxy.yml` 接入已有反向代理，则使用下面这条命令：

```sh
docker compose -f docker-compose.yml -f docker-compose.proxy.yml -f deploy/docker-compose.voice-recovery.yml up -d --build
```

`deploy/docker-compose.voice-recovery.yml` 是给原有部署叠加自动恢复配置的文件，不能单独使用。上述命令同时构建应用镜像和语音恢复镜像；不要只更新 LiveKit 镜像。

## 可选：离线导入镜像

这是另一种备用部署方式，你现在使用 Git 自动构建和 Portainer 拉取镜像，不需要执行这一节。

有方便使用的 Linux Docker 主机时，可以在项目根目录运行：

```sh
sh scripts/export-portainer-image.sh
```

脚本生成 `backspace-cn_1.4.5.tar` 和 `backspace-livekit_1.13.7-recovery.tar`，对应本地镜像名为 `backspace-cn:1.4.5` 和 `backspace-livekit:1.13.7-recovery`。

导入这两个文件后，需要将部署镜像覆盖为这两个本地镜像名，并使用本地镜像重新创建容器。这种方式不需要重新从 GHCR 拉取镜像。

## 可选参数：通常不需要修改

这些是容器里的环境变量。Portainer 配置已经暴露 `LIVEKIT_IP_PROBE_URLS` 和 `LIVEKIT_DDNS_DOMAINS`，需要时可在 Stack 环境变量中填写。其余参数已写入部署文件；确实需要调整时，要修改对应容器的 `environment` 配置。

| 环境变量 | 作用和默认值 |
| --- | --- |
| `LIVEKIT_IP_PROBE_URLS` | 获取公网 IPv4 的探测地址。默认使用 `https://api4.ipify.org` 和 `https://ipv4.icanhazip.com`。至少配置两个地址，用英文逗号分隔；每个地址必须使用 HTTPS，并返回纯文本公网 IPv4。两个探测服务都需要能从主机访问 |
| `LIVEKIT_DDNS_DOMAINS` | 要检查的 DDNS 域名，多个域名用英文逗号分隔。不填时，检查环境变量中提供的 `DOMAIN`、`LIVEKIT_URL` 和 `LIVEKIT_TURN_DOMAIN`；填写 URL 时会自动提取域名 |
| `LIVEKIT_LOCAL_HEALTH_URL` | 检查本机 LiveKit 信令服务是否正常，默认 `http://127.0.0.1:7880/`。只有修改了信令端口时才需要对应调整 |
| `LIVEKIT_RECOVERY_STATE_PATH` | 恢复状态文件，默认 `/run/backspace-voice/state.json`。部署配置已经通过共享卷让语音服务写入、应用只读访问 |
| `LIVEKIT_RECONNECT_GRACE_MS` | 应用端的普通断线保留时间，单位为毫秒。新版部署使用 `300000`，即 5 分钟；未启用恢复部署的原有默认值是 1 分钟 |

探测公网 IP 时使用主机的 IPv4 出口，不使用 HTTP 代理环境变量。如果两个默认探测地址在你的网络里无法访问，需要换成两个符合上述要求、可以正常访问的地址。

## 自动恢复的范围和工作方式

守护程序每 30 秒探测一次公网 IPv4。连续两次探测结果一致、两个探测服务也返回相同地址，并确认与 LiveKit 的启动地址不同后，才触发进程重启。探测失败会重新开始确认，不会直接重启。

重启时先通知旧进程退出，最多等待 10 秒，必要时强制结束，再启动新进程。两次自动重启至少间隔 120 秒，10 分钟内最多重启三次，重启记录会保存下来。

LiveKit 的启动地址、本机信令健康检查和配置的域名解析都通过后，才报告服务就绪。容器刚启动时也会先报告“恢复中”。DDNS 更新延迟本身不会反复触发进程重启。

一次异常的恢复状态期限固定为 10 分钟，重复检查或容器重启不会延长同一次异常的期限。LiveKit 意外退出时，由容器的重启策略接手；手动停止容器时，守护程序和 LiveKit 进程都会退出。

客户端先给 LiveKit 自带的重连逻辑 30 秒时间。仍未恢复时，应用会重新获取连接凭证并创建新的语音连接。失败后按约 1、2、4、8、15、30 秒的间隔继续重试，每次尝试最多 35 秒；网络离线时暂停，网络或服务恢复时唤醒重试。

Android 会保留原来的通话前台服务，并恢复麦克风和仍然可用的已选音频设备。

本次新增的自动恢复针对空间语音频道。摄像头、屏幕共享和跨实例私聊通话不在本次自动恢复范围内。登录失效、权限被拒绝、被移出频道或身份被另一会话顶替时，会停止恢复。

自动恢复要求原客户端进程仍在运行。关闭应用、刷新页面或被系统结束进程后，不会自动重新加入；浏览器后台休眠和 DNS 缓存也可能延迟恢复。

## 开发人员验证

在有 Go 环境的 Linux 测试主机上，可从项目根目录执行：

```sh
cd deploy/livekit-supervisor
go test ./...
```

在可用的测试环境中，还需要运行语音恢复调度、浏览器语音采集、服务端断线保留时间相关的 Vitest 测试，以及 Android 测试。最终仍需完成前面的外网双向语音验收，本机健康检查通过不能代替外网媒体连接测试。
