# 安卓固定签名与自动构建

已配置固定发行签名，包名保持 `me.kevz.backspace`。签名证书公开指纹保存在 `packages/android/signing-certificate.sha256`；本地和 GitHub 构建均校验该指纹。私钥不在源码或 APK 内。

## 已配置

- GitHub Actions：`.github/workflows/android-debug.yml` 的显示名称改为 **Android APK**。推送 master、推送版本标签、手动运行均构建固定签名的 release；缺少 Secrets 会失败，不会生成临时发行密钥。
- GitHub 仓库 Secrets：`BACKSPACE_ANDROID_KEYSTORE_BASE64`、`BACKSPACE_ANDROID_STORE_PASSWORD`。两者来自本机同一份发行密钥。
- PR 仅构建 debug APK，包名为 `me.kevz.backspace.debug`，可与正式版并存。
- 构建产物包括 `app-release.apk`、签名验证结果及 SHA256SUMS；artifact 名为 `backspace-android-release-提交SHA`。

## 本地密钥和备份

Windows 路径：`%LOCALAPPDATA%\BackspaceAndroidSigning`。请一起备份 `backspace-release.p12` 和 `signing.json` 到另一块盘或自己的密码库。不要删除、重新生成或只保留其中一个；不要把密钥发给 APK 接收者。

当前密钥为首次固定发行密钥；此前临时 debug 密钥没有保存。旧调试版可能需要最后卸载一次，再安装固定签名发行版，卸载会删除本地登录信息和设置。服务器账号和服务器消息不受卸载影响。此后安装同签名新版可覆盖更新。

后续本地构建使用 Java 21、Android SDK 36：

```powershell
./scripts/build-android-release.ps1
```

本机工具位于 `%LOCALAPPDATA%\BackspaceBuildTools`。新机器应先恢复密钥备份，禁止重新初始化。`-InitializeSigning` 仅用于没有任何旧密钥的首次初始化；密码存在但密钥丢失时，脚本拒绝重建。

如需重新向 GitHub 配置同一份密钥，使用 GitHub CLI 登录后运行：

```powershell
gh auth login
./scripts/configure-android-github-signing.ps1
```

本机脚本也支持复用 Git Credential Manager 中已有的 GitHub 登录，不会输出凭据。

## 后续发布

1. 修改功能后提交并推送到 master，或在 Actions 的 **Android APK** 中手动运行。
2. 下载 `backspace-android-release-…` artifact，解压安装其中的 `app-release.apk`。
3. 正式发布新版时运行 `node scripts/bump-version.mjs 新版本号`，保持所有包版本一致并递增 Android versionCode。

固定签名不能恢复已经丢失的旧签名私钥，也不代替真机验收。
