# Windows HDR 验证工具与接入状态

本目录是开发验证工具，尚不是可用的 HDR 直播功能。正式设置开关保持未上线；没有客户端获得 HDR 播放放行。现有 SDR 直播继续使用原来的采集与发布路径。

## 本次已实现

- 原生只读显示器检测：使用 DisplayConfig、IDXGIOutput6 读取当前输出色彩空间，并将 WCG 与 HDR 区分。旧系统无法确认 HDR 时拒绝采集。按 GDI 名称匹配选中的显示器，使用其 HMONITOR 捕获，不猜测屏幕编号。
- WGC/D3D11 FP16 scRGB 采集脚本；以 80 cd/m² 为 scRGB 参考白，转换为 BT.2020/PQ、P010 后使用一个 HEVC Main10 NVENC 编码器。没有 SDR 转换输出、VP8、额外上传或系统音频采集。
- CPU/zscale 参考转换与 Vulkan/libplacebo GPU 转换两种实验路径。两者均检查解码后的高光灰阶，GPU 路径通过着色器校正 libplacebo 的参考白，避免只改颜色标签。
- 检查 Annex B HEVC 参数集的 profile、位深、色域和传递函数，而非只检查容器标签。合成图案使用浮点 0/80/200/1000 nit，解码检查其亮度，检测高光是否被截断。
- 采集中每秒重新检测所选显示器。HDR 关闭、显示器更换/移除、探测失败、原生进程失败或超时均终止此次实验，不自动换屏或回退 SDR。
- 本地 `hdrEnabled` 默认关闭，旧配置迁移为关闭；直播时禁止改变 HDR 意图；SDR 编码偏好独立保留。浏览器采集/发布拒绝 HDR 请求，避免把普通 HEVC/SDR 当成 HDR。
- 每位主播可选的 `dynamicRange` 状态贯穿服务端状态、ready/中途加入快照、重连及网页端。旧状态缺省按 SDR。网页/桌面和安卓识别 HDR 标识及不支持提示；视频和系统音频订阅均拒绝，频道语音保持正常。

保留轨道名 `backspace-screen-hdr-v1`，供未来原生发布器在真实 HDR 发布成功后使用。观看端也检查轨道名，避免等待 WebSocket 状态时误订阅。当前实验不会将任何本地编码成功结果标成线上 HDR 直播。

## 在 Windows 上复现

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

较新的 FFmpeg 二进制要求 NVENC 13.1/驱动 610，本机驱动仅提供 13.0。工具可将新版运行库用于 WGC 采集、旧版用于 NVENC，中间管道仅传递本机浮点像素，仍只有一个压缩视频编码器。没有静默切换编码器或转换为 SDR。

## 2026-10-17 本机结果

RTX 4070 SUPER，驱动 596.21。G73 的高级色彩受支持，但当前系统 HDR 未开启；PHL 272M8 未报告高级色彩支持。两者的实际 DXGI 输出色彩空间均为 SDR。真实 HDR 采集入口在创建采集进程前被拒绝，尚未进行桌面 HDR 采集。

合成浮点灰阶的 NVENC 输出通过：HEVC Main 10、yuv420p10le、BT.2020/PQ、limited range。解码后 80/200/1000 nit 三块高光可区分，误差在检查阈值内。

| 合成输入（600 帧） | 转换 | 编码处理耗时 | FFmpeg 处理帧率 |
| --- | --- | ---: | ---: |
| 1920×1080，60 fps | CPU/zscale | 6.57 秒 | 93.26 fps |
| 3840×2160，60 fps | CPU/zscale | 39.49 秒 | 15.26 fps |
| 3840×2160，60 fps | Vulkan/libplacebo | 31.44 秒 | 约 19 fps |

这是色彩正确性的实验，包含浮点像素跨进程/CPU/GPU 复制。4K60 尚不满足实时要求，需要原生 D3D11 纹理到颜色转换/NVENC 的 GPU 路径。GPU 样本包含机器上其他应用的负载，不是独占性能测量。静态合成图案的文件码率不可用作直播带宽估算。

## 仍需实现与验收

以下内容尚未完成，不能将本次代码描述成完整 HDR 直播：

1. 实现避免浮点读回的 D3D11 GPU 色彩转换/NVENC 路径，验证真实桌面 1080p60 和 4K60。
2. 实现 LiveKit 原生发布/接收传输，以及发布进程归属现有主播的生命周期管理。当前脚本只写本地视频，没有上传功能。
3. 实现 Windows 原生 Main10 解码和 HDR 渲染能力验证，检测观看窗口所在的输出显示器，处理 HDR 关闭、换屏和解码失败。当前播放器全部拒绝 HDR，而不是仅凭 HEVC 支持放行。
4. 接入服务器能力协商；在原生视频发布成功后同步 HDR 状态，并覆盖进程退出、停止直播和重连。当前只有兼容的状态字段及观看保护，不能代表服务器已经支持原生 HDR 发布。
5. 上述链路完成后接入正式“开启 HDR 直播间”设置、固定 HDR 编码显示、开播预检和直播中锁定提示；最后进行两台 Windows HDR 设备的 LiveKit 联测、性能与带宽记录。
6. 验收通过后发布客户端，并同步部署服务器网页。桌面外壳更新不能替代服务器网页更新。

参考：[Microsoft WGC HDR 捕获](https://learn.microsoft.com/en-us/windows/uwp/audio-video-camera/screen-capture)、[FFmpeg gfxcapture](https://ffmpeg.org/ffmpeg-filters.html#gfxcapture)、[Microsoft DXGI_OUTPUT_DESC1](https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_6/ns-dxgi1_6-dxgi_output_desc1)。
