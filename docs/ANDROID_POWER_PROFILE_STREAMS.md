# 安卓后台、资料页与直播观看变更

日期：2026-10-02。源码版本：1.3.20，包名 `me.kevz.backspace`。

## 行为

- 新消息来自原生 WebSocket 实时推送，没有定时拉取消息。移除安卓网页每 500 毫秒的连接检查；应用心跳每 60 秒一次，发送后等待 pong 最多 30 秒。服务端每 30 秒的协议心跳保持原样。
- 开启后台在线时仍接收消息与来电。后台通知、通话与音乐处理由原生完成，隐藏的网页暂停处理业务事件；恢复时按各连接独立序号补发、批量确认。最多缓冲 512 条未消费事件，缺口或网页状态丢失才重新连接获取完整状态。
- 无网络时暂停重试，网络恢复立即连接；失败连接使用随机指数退避，最多 30 秒，稳定在线一分钟才重置失败次数。活动显示共用计时器，隐藏时暂停。
- “分享正在播放的音乐”只采集歌曲、歌手和封面，还需“分享活动状态”总开关、通知访问权限及在线连接。设置页分别显示关闭、离线、缺少权限、总开关关闭的原因。采集继续由系统回调驱动，保留去重、3.2 秒限频和暂停两分钟后清除。
- 移动端个人信息直接进入页面栈，保留联邦用户来源、共同好友、共同空间与好友操作。返回按钮、侧滑及安卓手势走历史返回，逐层退出；桌面继续使用弹窗。资料加载失败可以返回，较早请求不会覆盖后来打开的人。
- 加入语音频道后，在通话页面的“频道直播”点击成员，打开原生全屏观看页。只接收一路屏幕直播与直播声音，复用现有 LiveKit Room。可返回、开关直播声音和静音麦克风；支持横竖屏、安全区和浅深主题。
- 返回观看页以外停止直播订阅，继续频道语音。切后台或锁屏暂停直播画面和声音，回到观看页自动恢复。停播显示结束状态，重连绑定新轨道，离开频道、退出账号或切服务器关闭观看页。没有新增摄像头或屏幕录制权限。

## 已完成的验证

- 网页：141 个测试文件、1103 项测试通过；TypeScript 和语言键检查通过。
- 原生：31 项 Robolectric/策略测试、Kotlin/Java 编译及完整 release lint、release 构建通过。包括事件补发/确认/溢出、心跳超时、断网恢复、前台 Activity 与网页可见状态分离、目标直播订阅和音量策略。
- 安卓返回回归：资料页覆盖聊天搜索时，系统返回只退出资料页；独立测试通过。浏览器模拟的登录布局在 360/412 像素及浅/深主题组合下通过四项检查。
- 原生 UI 和实际 LiveKit 解码、硬件、声音、手势没有被浏览器模拟替代。

## 发布与待验收

按维护者授权，已生成并固定发行密钥，配置 GitHub Actions Secrets；本地签名 release 已构建并验证。之前自动构建使用临时 debug 签名，切换时可能需要最后卸载一次。后续本地和 CI 复用同一密钥。密钥备份及发布步骤见 [固定签名说明](ANDROID_SIGNING.md)。构建机使用独立的 Java 21 和 Android SDK 工具目录，没有修改系统默认 Java。

签名构建产物：`packages/android/android/app/build/outputs/apk/release/app-release.apk`。已验证固定证书、包名 `me.kevz.backspace`、版本 `1.3.20`（1003020）、ARM64/ARMv7，未包含摄像头或屏幕录制权限。直播相关自动测试覆盖运行时和订阅/音量策略；真实 Room 重连、解码和渲染器释放仍须下述真机验收。

设备连接列表为空，以下项目尚未验收：

- [ ] 安卓系统手势、页面侧滑、资料按钮连续返回，多层共同好友页面；聊天滚动位置和草稿保持。
- [ ] Windows 屏幕直播画面及声音、频道语音同时播放、静听与成员静音、蓝牙切换。
- [ ] 横竖屏、主题、安全区、锁屏暂停恢复、停播、断网重连、离开频道和切换账号的资源释放。
- [ ] 同签名覆盖安装并保留账号和设置。
- [ ] 同设备、同网络分别对比旧版与新版：后台静置、音乐分享、频道语音，各至少 30 分钟。记录耗电、CPU、网络流量、重连次数、通知延迟。不得预填耗电下降百分比。

## 重建

设置当前进程的 `JAVA_HOME` 为 Java 21、`ANDROID_HOME` 为 Android SDK（API 36），运行：

```powershell
pnpm --filter @backspace/web test
pnpm --filter @backspace/web build:android
node scripts/check-i18n.mjs
pnpm --filter @backspace/android exec cap sync android
./packages/android/android/gradlew.bat -p packages/android/android :app:testDebugUnitTest :app:assembleRelease --console=plain
```

未设置 `BACKSPACE_ANDROID_KEYSTORE` 时只生成未签名 release 包。签名发行须设置原 keystore 路径与 `BACKSPACE_ANDROID_STORE_PASSWORD`，沿用既有 `backspace` alias；完成后使用 `scripts/package-android-delivery.mjs` 验证签名、包名、版本、ARM ABI 及资源。
