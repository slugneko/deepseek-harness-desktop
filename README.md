# DeepSeek Harness Desktop (Windows)

将 DeepSeek Harness 的 Web 版打包为 Windows 单文件 EXE 安装包：安装后双击桌面图标，
自动拉起本地服务并在 Electron 窗口中打开界面（界面/样式/功能与 Web 版一致）。

## 架构

```
DeepSeekHarness.exe (Electron)
 └─ 主进程 (electron/main.js)
     ├─ 单实例锁
     ├─ spawn 便携 Node: node <dsh>/lib/bin.js web --port 0
     ├─ 解析 stdout "dsh web: http://127.0.0.1:<port>" 判定就绪
     ├─ BrowserWindow 加载该 URL
     ├─ 首次运行弹「配置 DeepSeek API Key」引导
     └─ 退出时回收子进程
```

关键点：DSH 服务端始终运行在**标准便携 Node** 子进程上，规避 Electron 内置 Node 的
ABI 差异（node-pty / sharp 等原生模块直接复用官方 win32-x64 预编译产物，零重编）。

## 目录结构

```
electron/main.js            Electron 主进程壳
electron-builder.yml        打包配置（NSIS、每用户安装）
scripts/build-runtime.ps1   运行体组装脚本（复制 DSH + 便携 Node + 裁剪）
scripts/launch.js           无 Electron 冒烟启动器（开发验证）
build/runtime/              组装产物（dsh/ + node/，.gitignore 忽略）
dist/                       打包产物（安装包 EXE）
```

## 前置条件（构建机）

- Windows x64
- Node.js **v24.x LTS**（必须与 `build/runtime/node` 便携 Node 同版本，保证原生模块 ABI 一致）
- 已安装 DSH：`npm install -g @deepseek-ai/dsh`（或用 `-DshSource` 指定目录）
- 可访问 npm registry 与 github（下载 electron / electron-builder 及打包资源）

## 构建

```powershell
npm install                 # 安装 electron + electron-builder（下载体积较大）
npm run build:runtime       # 组装 build/runtime（复制 DSH + 便携 Node + 裁剪）
npm run dist                # 打包出安装包
```

产物：`dist/DeepSeek-Harness-Setup-0.1.0-rc.6.exe`

## 本地开发运行（不打包）

```powershell
npm run build:runtime
npm start                   # Electron 窗口运行
# 或
npm run verify              # 无 Electron：起服务 + 打开默认浏览器（冒烟）
```

## 决策说明（与方案文档一致，均采用推荐项）

| 项 | 选择 |
|---|---|
| 安装器格式 | NSIS（electron-builder 默认），单 EXE |
| 安装范围 | 每用户安装到 `%LOCALAPPDATA%\Programs\DeepSeek Harness`，免管理员 |
| 数据目录 | `<installDir>\data`（DSH_HOME），卸载随安装目录一并清除 |
| 遥测 | 默认关闭（`DSH_TELEMETRY_DISABLED=1`）；设 `DSH_DESKTOP_ENABLE_TELEMETRY=1` 恢复 |
| 端口 | `--port 0` 由 OS 分配，从 stdout 解析，规避 3080 占用 |
| DSH 版本 | 锁定 `@deepseek-ai/dsh@0.1.0-rc.6` |

## 待办

- [ ] 正式图标 `build/icon.ico`（当前用 Electron 默认图标）
- [ ] 代码签名证书（消除 SmartScreen 提示）
- [ ] 自动更新（electron-updater）
