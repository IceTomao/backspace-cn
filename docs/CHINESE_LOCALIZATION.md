# Backspace 简体中文本地化

## 范围

本分支只修改客户端显示层：

- `packages/web/src/locales/zh/`：网页端文案
- `packages/desktop/src/l10n.ts`：Electron 桌面端托盘、菜单、更新提示

服务端 API、数据库、认证、WebSocket 和 LiveKit 逻辑保持不变。服务端返回的错误代码由网页客户端的 `errors` 命名空间显示，因此错误提示也属于客户端翻译范围。

## 当前基线

- 来源：Backspace `main` 分支
- 网页端语言命名空间：16 个
- 英文目录叶子文案：约 2,074 条
- 现有语言：English、Русский、Deutsch
- 中文语言代码：`zh`
- 简体中文目录：16 个命名空间，共 2,074 条叶子文案
- 草稿与校对源：`translation-draft/zh/`
- 运行时目录：`packages/web/src/locales/zh/`
- 桌面端托盘、菜单和更新提示已完成中文目录
- 网页端和桌面端均已发布 `zh`，可识别 `zh-CN` 并在设置中手动切换

## 发布规则

中文已标记为 `released: true`。修改草稿后先运行合并脚本，再执行检查和构建：

```powershell
node scripts/merge-zh-draft.mjs
node scripts/check-i18n.mjs
pnpm --filter @backspace/web build
```

`translation-draft/` 不会被客户端直接加载，也不会进入 Docker 构建上下文；Docker 使用的是已合并到 `packages/web/src/locales/zh/` 的正式目录。

## 本地检查

```powershell
node scripts/check-i18n.mjs
pnpm --filter @backspace/web build
pnpm --filter @backspace/desktop build
```

## 自部署构建

翻译完成后，在仓库根目录执行：

```powershell
docker compose up -d --build
```

首次安装推荐使用项目安装器，并强制从当前源码构建，避免拉取不含中文修改的官方预构建镜像：

```bash
BACKSPACE_BUILD=true ./install.sh
```

生产镜像会同时包含服务端和构建后的网页客户端。不需要修改服务端业务代码。

完整交接步骤见 `docs/BACKSPACE_CN_HANDOFF.md`。
