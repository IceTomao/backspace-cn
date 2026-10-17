# Windows HDR 验证工具与接入状态

截至 2026-10-18，已接入 Windows 原生发布、LiveKit 转发、原生观看、系统音频及设置界面，并完成下面的自动检查。**尚未完成真实 HDR 双机验收，正式客户端仍禁止开启 HDR。** `packages/desktop/native/acceptance.json` 的 `releaseAccepted` 保持 `false`；合成码流测试和编译成功不会修改该值。

## 本次已实现

- 原生只读显示器检测：使用 DisplayConfig、IDXGIOutput6 读取当前输出色彩空间，并将 WCG 与 HDR 区分。旧系统无法确认 HDR 时拒绝采集。按 GDI 名称匹配选中的显示器，使用其 HMONITOR 捕获，不猜测屏幕编号。
- 原生 `HdrGpu.exe` 在同一个 NVIDIA D3D11 设备内进行 WGC FP16 scRGB 采集 → compute shader 转换 BT.2020/PQ → P010 纹理 → NVENC HEVC Main10。以 80 cd/m² 为 scRGB 参考白，原始像素不读回 CPU，也不通过进程管道来回复制；只有压缩后的 HEVC 交给 LiveKit 桥接程序。没有 SDR 转换输出或 VP8 备用视频。可选系统音频使用 WASAPI loopback → Opus，不使用麦克风轨道。
- shader 保留浮点精度完成色域与 PQ 转换，再量化到 10-bit；缩放在 GPU 上按比例进行，支持黑边。UHD 使用 NVENC P3，其余使用 P4，均为超低延迟、无 B 帧、无 lookahead、CBR，单个视频编码器。独立 CPU/zimg 参考检查灰阶、饱和色、负 scRGB 分量，另检查动态纹理更新与缩放后的黑边。旧 CPU/zscale、Vulkan/libplacebo 实验保留作参考，不再用于客户端发布。
- 检查 Annex B HEVC 参数集的 profile、位深、色域和传递函数，而非只检查容器标签。合成图案使用浮点 0/80/200/1000 nit，解码检查其亮度，检测高光是否被截断。
- 采集中每秒重新检测所选显示器。HDR 关闭、显示器更换/移除、探测失败、原生进程失败或超时均终止此次实验，不自动换屏或回退 SDR。
- “直播流设置”保存 `hdrEnabled`，默认关闭，旧配置迁移为关闭；直播时锁定开关，HDR 固定 HEVC Main10，保留独立 SDR 编码偏好。原生模式不调用浏览器 SDR 采集。
- 每位主播可选的 `dynamicRange` 状态贯穿服务端状态、ready/中途加入快照、重连及观看入口，缺省按 SDR。网页、桌面和安卓显示 HDR 标识；没有通过原生预检的设备显示“该直播间为 HDR 直播间，本机设备暂不支持查看”，拒绝该直播的视频和系统音频，保留频道语音并提供重新检测。
- Go 桥接进程通过 LiveKit 发布/接收单路 HEVC 及可选系统音频。服务端要求当前主播已在语音频道并具有权限，检查 SFU 上实际 H.265 视频轨道后才广播 HDR；原生进程归属主播，不另显示为语音成员。离开、停止、权限撤销、原生进程退出、服务器重启残留均有清理流程。
- Windows 播放器先解码本地 Main10/PQ 测试片，再检查 D3D11VA、实际视频颜色参数、D3D11 10-bit 交换链与窗口所在显示器的 PQ 输出，成功后才启动订阅。不能仅凭支持 HEVC 或显示器型号放行。观看中 HDR 关闭、换屏或解码/渲染失败会停止播放；直播音量、静音和关闭声音状态同步至原生播放器。
- Electron 主进程限制 IPC 来源、可执行文件和原生参数，使用标准输入传递凭据；退出、更换页面或语音会话会停止原生子进程。

视频轨道名为 `backspace-screen-hdr-v1`，系统音频为 `backspace-screen-hdr-audio-v1`。观看端在 WebSocket 状态到达前也按保留轨道名拒绝浏览器订阅。新 GPU 路径已通过本机 1080p60 / 4K60 动态合成吞吐检查；真实桌面 WGC、HDR 输出与双机直播效果仍待硬件验收。

## 原生接入的构建与自动验证

需要 Windows x64、Node.js、Go 1.26.8 或更新版本、Windows 自带 .NET Framework C# 编译器与 7-Zip。`setup-gpu-tools.mjs` 下载并校验固定 Zig 0.15.2 编译器到忽略目录，不修改系统安装。GPU 构建检查固定 NVENC API 13.0 头文件的 SHA-256，并将 HLSL 嵌入程序。构建与验证脚本可传 `--go 'D:/Tools/go/bin/go.exe'` 指定 Go，构建可传 `--zig 'D:/Tools/zig/zig.exe'` 指定同一版本编译器。

```powershell
node experiments/windows-hdr/setup-runtime.mjs encoder
node experiments/windows-hdr/setup-runtime.mjs livekit
node experiments/windows-hdr/setup-runtime.mjs player
node experiments/windows-hdr/setup-gpu-tools.mjs
node packages/desktop/scripts/build-hdr-native.mjs --assemble-runtime
node --test experiments/windows-hdr/gpu-guards.test.mjs
node experiments/windows-hdr/verify-native.mjs

# 需要真实 NVIDIA GPU，但不采集桌面；检查色彩、缩放、帧更新和吞吐。
node experiments/windows-hdr/gpu-lab.mjs --width 1920 --height 1080 --bitrate 16000 --output experiments/windows-hdr/.artifacts/gpu-1080
node experiments/windows-hdr/gpu-lab.mjs --width 3840 --height 2160 --bitrate 32000 --output experiments/windows-hdr/.artifacts/gpu-4k
# 将新 GPU 编码器的合成输出通过真实本地 LiveKit 再验证。
node experiments/windows-hdr/verify-native.mjs --fixture experiments/windows-hdr/.artifacts/gpu-4k/grey.hevc
```

原生联测仅限**未打包的开发客户端**，设置 `$env:BACKSPACE_HDR_LAB = '1'` 后运行 `pnpm --filter @backspace/desktop dev:win`。服务端还需配置原有 LiveKit 凭据与 `LIVEKIT_NATIVE_HDR_ENABLED=true`，SFU 的 `enabled_codecs` 至少包含 `video/h265` 和 `audio/opus`。系统 HDR、所选显示器与真实编码/解码预检仍然生效。

服务端默认关闭 HDR 协议；旧服务端或缺少原生能力的客户端禁用开关。正式打包客户端忽略上述开发环境变量。`electron-builder.hdr.yml` 仅供显式开发打包，正常发布不自动包含未验收的原生依赖。公开分发前还需完成 `packages/desktop/native/THIRD_PARTY_NOTICES.md` 所记录的许可证和对应完整源码/构建依赖归档。

## 2026-10-18 自动检查结果

`verify-native.mjs` 启动仅监听回环地址的真实 LiveKit SFU，使用产品 Go 桥接程序发布、接收合成 NVENC HEVC 及 Opus，再检查接收码流和解码后高光。不采集桌面，不使用生产凭据。GitHub Actions `Windows HDR native checks` 会在相关代码 push / PR 时执行此检查。

- 视频为 HEVC Main10、yuv420p10le、BT.2020/PQ、256×128 / 60 fps；接收的 Opus 为 48 kHz 双声道，可解码。
- 0 / 80 / 200 / 1000 nit 合成灰阶解码后的 10-bit 亮度值为 64 / 489 / 571 / 722，预期为 64 / 490 / 571 / 723，高光可区分。
- 1 MiB 关键帧 RTP 分片/重组完整性测试通过，避免默认小缓冲区丢弃大帧。
- 观看端的 MPEG-TS 直接转封装检查通过，保留短流起始画面及 Main10/PQ 高光，不额外编码视频。
- 本机 RTX 4070 SUPER 上产品 NVENC 参数的真实编码预检通过。WASAPI 循环采集输出 44.1 kHz 双声道浮点格式，输出后丢弃，没有保存音频录制。
- 自动检查覆盖设置迁移、直播锁定、编码偏好、观看订阅隔离、旧协议拒绝、主进程来源校验、取消与过期事件、真实轨道证明、权限撤销和停止竞态。网页 1175 项、桌面 278 项、服务端相关 27 项、安卓相关 48 项测试通过；网页、服务端、桌面构建通过。

报告生成在 `.artifacts/native-transport-report.json`，仓库保留无凭据副本 `results/2026-10-18-native-transport.json`。`transportVerified=true` 只表示合成媒体通过 SFU；`endToEndVerified` 和 `hardwareHdrDisplayVerified` 仍为 `false`。

## 原生 GPU 路径自动检查

RTX 4070 SUPER，驱动 596.21；使用 GPU 生成动态 FP16 图案，分别连续编码 600 帧，并按 60 fps 节奏另测 180 帧。完整报告保存在 `results/2026-10-18-gpu.json`，包含色彩参考、连续帧哈希、实际处理时长及节奏测试。单个编码器，原始像素不读回 CPU；所有视频均为合成内容。

| 合成动态输入 | NVENC | 转换/编码吞吐 | 含进程启动的吞吐 | 60 fps 节奏测试 |
| --- | --- | ---: | ---: | ---: |
| 1920×1080，16 Mbps | P4 ULL | 215.33 fps | 196.92 fps | 59.93 fps |
| 3840×2160，32 Mbps | P3 ULL | 70.56 fps | 68.16 fps | 59.89 fps |

GPU 编码器的灰阶解码值为 64 / 490 / 571 / 723，和 0 / 80 / 200 / 1000 nit 预期一致；四组彩色图案与独立 zimg 参考的误差最大为 2 个亮度码值、1 个色度码值。缩放、黑边和连续动态画面检查通过。其合成输出经真实本地 LiveKit 转发和观看端直接转封装后，Main10/PQ 与上述高光值保持正确，Opus 音频正常。

GitHub 托管 runner 不要求 NVIDIA 硬件，执行原生编译、非法参数拒绝及固定合成流 SFU 验证；上表真实 GPU 检查由本机单独执行。这些结果未包含真实 WGC 采集、另一台电脑的 HDR 屏幕或真实上行带宽。正式开关保持禁用。

## 旧参考实验在 Windows 上复现

需要 Node.js、Windows 自带 .NET Framework C# 编译器、7-Zip，以及支持 Main10 的 NVIDIA 显卡/驱动。依赖下载仅发生在手动执行本工具时；不会随客户端运行或打包。下载按固定 GitHub release asset ID 和 SHA-256 校验，许可证和源码说明保留在解压目录。

从仓库根目录运行：

```powershell
node --test experiments/windows-hdr/pipeline.test.mjs
node experiments/windows-hdr/lab.mjs probe
node experiments/windows-hdr/setup-runtime.mjs encoder
node experiments/windows-hdr/setup-runtime.mjs capture

$hdrEncode = 'experiments/windows-hdr/.artifacts/runtime/ffmpeg-8.0.1-full_build-shared/bin/ffmpeg.exe'
$hdrProbe = 'experiments/windows-hdr/.artifacts/runtime/ffmpeg-8.0.1-full_build-shared/bin/ffprobe.exe'
$hdrCapture = 'experiments/windows-hdr/.artifacts/runtime/ffmpeg-8.1.2-full_build-shared/bin/ffmpeg.exe'

# 不采集桌面：检查实际 NVENC 10-bit/PQ 输出及高光。
node experiments/windows-hdr/lab.mjs synthetic --ffmpeg $hdrEncode --ffprobe $hdrProbe --width 1920 --height 1080 --fps 60 --seconds 10
node experiments/windows-hdr/lab.mjs synthetic --gpu-conversion --ffmpeg $hdrEncode --ffprobe $hdrProbe --width 3840 --height 2160 --fps 60 --seconds 10

# 真实采集：先在系统设置中为所选显示器打开 HDR。
# display 参数必须匹配 probe 的 gdiName；示例不代表其他电脑上的屏幕。
node experiments/windows-hdr/lab.mjs capture --display '\\.\DISPLAY1' --capture-ffmpeg $hdrCapture --ffmpeg $hdrEncode --ffprobe $hdrProbe --gpu-conversion --width 1920 --height 1080 --fps 60 --seconds 10

# 对接收端导出的真实 HEVC 码流另做参数检查。
node experiments/windows-hdr/lab.mjs inspect --file 'received.hevc' --ffmpeg $hdrEncode --ffprobe $hdrProbe
```

非默认安装位置的 7-Zip 可作为 setup-runtime 的第三个参数，例如 `node experiments/windows-hdr/setup-runtime.mjs encoder 'D:/Tools/7z.exe'`。

实验输出与依赖位于被 Git 忽略的 `.artifacts/`；真实采集会在该目录保存桌面视频。`report.json` 记录颜色信息、高光检查、FFmpeg CPU/内存、GPU 样本、处理时长及文件码率。报告中的 `endToEndVerified` 始终为 false；工具没有自动放行产品开关的功能。

旧 FFmpeg 实验中，较新二进制要求 NVENC 13.1/驱动 610，本机驱动仅提供 13.0。该参考工具将新版运行库用于 WGC 采集、旧版用于 NVENC，中间管道传递本机浮点像素。新原生 GPU 发布器直接使用 API 13.0，不依赖 FFmpeg WGC 采集库，也不需要升级本机驱动。两条路径均不静默切换编码器或转换为 SDR。

## 2026-10-17 本机结果

RTX 4070 SUPER，驱动 596.21。G73 的高级色彩受支持，但当前系统 HDR 未开启；PHL 272M8 未报告高级色彩支持。两者的实际 DXGI 输出色彩空间均为 SDR。真实 HDR 采集入口在创建采集进程前被拒绝，尚未进行桌面 HDR 采集。

合成浮点灰阶的 NVENC 输出通过：HEVC Main 10、yuv420p10le、BT.2020/PQ、limited range。解码后 80/200/1000 nit 三块高光可区分，误差在检查阈值内。

| 合成输入（600 帧） | 转换 | 编码处理耗时 | FFmpeg 处理帧率 |
| --- | --- | ---: | ---: |
| 1920×1080，60 fps | CPU/zscale | 6.57 秒 | 93.26 fps |
| 3840×2160，60 fps | CPU/zscale | 39.49 秒 | 15.26 fps |
| 3840×2160，60 fps | Vulkan/libplacebo | 31.44 秒 | 约 19 fps |

这是旧参考路径的色彩正确性实验，包含浮点像素跨进程/CPU/GPU 复制，当时的 4K60 不满足实时要求。新的原生 D3D11 GPU 路径已替代它用于客户端发布，并通过动态合成吞吐检查。新旧图案与负载不同，不应将两组帧率作为严格的性能提升倍数。GPU 样本包含机器上其他应用的负载；合成图案文件码率不可用作直播带宽估算。

## 仍需实现与验收

正式发布前仍需完成以下工作：

1. 在新 D3D11 GPU 色彩转换/NVENC 路径上验证真实 WGC 桌面 1080p60 和 4K60，包括不同输入/输出尺寸、静止画面及持续运动。
2. 两台 Windows HDR 设备通过 LiveKit 联测，确认真实接收码流位深、色彩信息、高光层次、实际 HDR 输出、音画同步和长时间漂移。
3. 实机覆盖系统 HDR 关闭、跨显示器移动、解码失败、原生进程退出、中途加入、重连、权限撤销，以及同频道 SDR 主播和频道语音互不影响。
4. 根据硬件结果完善正式发布放行范围，记录编码帧率、延迟、显卡负载与上行带宽，完成运行库分发归档，再更新验收清单。
5. 验收通过后发布客户端，并同步部署服务器网页。桌面外壳更新不能替代服务器网页更新。

参考：[Microsoft WGC HDR 捕获](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture)、[FFmpeg gfxcapture](https://ffmpeg.org/ffmpeg-filters.html#gfxcapture)、[Microsoft DXGI_OUTPUT_DESC1](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_6/ns-dxgi1_6-dxgi_output_desc1)。
