# DeepSeek Harness（DSH）Windows 桌面安装包 — 打包工作文档

| 项 | 内容 |
|---|---|
| 文档版本 | v1.0 |
| 状态 | 待评审 / 待实施 |
| 目标产物 | 单个 Windows EXE 安装包，安装后双击桌面图标即自动运行 |
| 运行形态 | Electron 桌面外壳（内置 Chromium 窗口承载 Web 界面） |
| 版本基线 | `@deepseek-ai/dsh` **0.1.0-rc.6**（MIT） |

---

## 1. 目标与范围

### 1.1 目标

把当前以「终端命令行 + 本地浏览器」方式运行的 DeepSeek Harness，打包成一个面向普通 Windows 用户的安装包：

1. 用户双击安装包 → 免管理员权限安装到 `%LOCALAPPDATA%`（每用户）。
2. 安装完成后创建「桌面快捷方式 + 开始菜单快捷方式」。
3. 双击快捷方式 → 自动拉起一个桌面窗口（Electron），窗口内就是 DSH 的 Web 界面。
4. **界面、样式、功能与现在的 Web 版完全一致**（同一套前端静态产物、同一个后端服务）。
5. 首次运行引导用户配置 DeepSeek API Key。
6. 卸载时连同用户数据一并清除（数据放安装目录，卸载即删）。

### 1.2 交付物

- [ ] 可复现的构建脚本（`build/`，含 Node 运行时与 DSH 运行体的拉取/裁剪）
- [ ] Electron 桌面壳源码（`electron/`）
- [ ] electron-builder 打包配置（安装器：单 EXE、每用户、桌面/开始菜单快捷方式、自定义图标）
- [ ] 未签名的 `DeepSeek Harness Setup-x64.exe`
- [ ] 测试报告（全新 VM 上的安装 / 运行 / 卸载验证记录）

### 1.3 非目标（v1 暂不做）

- 代码签名（EV/OV 证书）——首版先出未签名包，SmartScreen 由用户点「仍要运行」绕过
- 自动更新（electron-updater）——后续版本再接入
- 每机器安装（Program Files）、MSI、GPO/SCCM 批量部署
- TUI / headless 命令行形态（只打包 web 图形界面）

---

## 2. 现状梳理（已核实）

| 项 | 结论 |
|---|---|
| 本质 | 纯 Node.js ESM 应用，npm 包 `@deepseek-ai/dsh@0.1.0-rc.6`，MIT |
| 运行时 | Node.js **v24.16.0**（构建机实测），需与打包内置的便携 Node 同版本 |
| 启动命令 | `node <dsh>/lib/bin.js web`（等价 `dsh web` / `dsh --profile web`） |
| 服务端口 | 默认 `127.0.0.1:3080`；支持 `--port 0` 由 OS 分配空闲端口 |
| Web 界面 | **预编译静态产物** `@deepseek-ai/dsh-web-frontend/dist`（89 文件 ≈ 4.6MB），**打包无需跑 Vite 构建** |
| 运行依赖 | `@deepseek-ai/dsh` 的嵌套 `node_modules` 即完整运行时：32,972 个文件 ≈ **246 MB**，含 194 个 `@deepseek-ai/*` 包 + 第三方 |
| 原生二进制 | node-pty（conpty/winpty）、sharp、koffi、`@vscode/ripgrep`、`node-addon-require-builtin-win32-x64-msvc` —— **win32-x64**，需匹配便携 Node 的 ABI |
| profile | `dsh.profile.bundles = ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]`，由 boot 首次运行时在 `$DSH_HOME/profiles/web` 自动生成 |
| 数据目录 | `$DSH_HOME` 下：`profiles/`、`sessions/`、`storages/`、`settings.yaml`、`.credentials.yaml` |
| 凭据 | API Key 存于 `$DSH_HOME/.credentials.yaml`，键名 **`DEEPSEEK_API_KEY`** |
| 默认模型 | `settings.yaml` → `agent-default-model.provider: deepseek-official`，由 Web「设置 → 模型」页维护 |
| 关键缺口 | `dsh web` 只打印 `dsh web: http://127.0.0.1:PORT`，**无自动开浏览器能力** → 由 Electron 壳补齐 |
| 安全约束 | 默认只绑 `127.0.0.1`；显式拒绝 `--host 0.0.0.0`（防局域网 RCE），壳层应保持 loopback |
| 遥测 | `DSH_TELEMETRY_DISABLED` 可关；默认上报 `harness-telemetry.deepseeksvc.com`（打包时决定是否默认关闭） |

> 说明：`@deepseek-ai/dsh` 的完整依赖是**嵌套**在其自身 `node_modules/` 下的（构建机全局安装即如此）。因此「DSH 运行体」= 整个 `@deepseek-ai/dsh` 安装目录（`lib/ + config/ + package.json + node_modules/`），原样搬运即可，无需重装。

---

## 3. 目标架构设计

### 3.1 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    DeepSeekHarness.exe (Electron)            │
│                                                             │
│  ┌───────────────────────┐         ┌─────────────────────┐  │
│  │  Electron 主进程 (main.js) │         │  Electron 渲染进程      │  │
│  │  · 单实例锁                │  loadURL │  (Chromium BrowserWindow) │  │
│  │  · 拉起身服务子进程        │ ───────► │  · 承载 DSH Web UI     │  │
│  │  · 等端口就绪/解析URL      │         │  · 界面样式功能不变     │  │
│  │  · 打开窗口                │         └─────────────────────┘  │
│  │  · 首次运行引导            │                                  │
│  └──────────┬────────────────┘                                  │
│             │ spawn (child_process)                             │
└─────────────┼──────────────────────────────────────────────────┘
              ▼
   ┌──────────────────────────────┐
   │  便携 Node.exe (与运行时同版本)  │
   │  node <dsh>/lib/bin.js web     │
   │  --port 0                       │
   │  DSH_HOME=<installDir>\data     │
   └──────────────┬─────────────────┘
                  │ 启动 HTTP 服务
                  ▼
         http://127.0.0.1:<port>   ← 由 Electron 窗口加载
```

### 3.2 进程模型（关键设计决策）

**Electron 只做「壳」，DSH 服务以子进程方式跑在便携 Node 上。**

理由（这是本方案最重要的正确性决策）：

1. **避免原生模块 ABI 不匹配**：node-pty / sharp 等原生 `.node` 是为**标准 Node v24** 编译的，而 Electron 内置 Node 的 ABI（`NODE_MODULE_VERSION`）不同。若让 DSH 跑在 Electron 进程里，必须 `electron-rebuild` 全部原生模块，脆弱且易碎。让 DSH 跑在**标准便携 Node** 子进程里，直接复用官方 npm 预编译产物，零重编。
2. **DSH 零改动**：DSH 仍是原来的服务端进程，功能/安全模型（loopback 绑定、trust fence、沙箱）原样保留。
3. **隔离与可停**：窗口关闭 → 杀子进程 → 服务干净退出（DSH 自带 SIGINT/SIGTERM 优雅关闭）。

### 3.3 端到端启动时序

1. 用户双击桌面快捷方式 → 启动 `DeepSeekHarness.exe`（Electron 主进程）。
2. `app.requestSingleInstanceLock()`：已有实例则聚焦已有窗口并退出。
3. 首次启动：把内置的 profile 模板/预置 agent-presets 落到 `DSH_HOME`（若 boot 未自动生成）。
4. `spawn(便携node, [bin.js, 'web', '--port', '0'], { env: { DSH_HOME, ... } })`。
5. 主进程监听子进程 stdout，解析到 `dsh web: http://127.0.0.1:<port>` 即认为就绪（超时 30s 失败提示）。
6. `BrowserWindow` 加载该 URL（`show:false` → `ready-to-show` 再显示，避免白屏闪烁）。
7. 首次运行且 `.credentials.yaml` 无 `DEEPSEEK_API_KEY` → 弹引导对话框（详见 §7）。
8. 窗口全关 → `app.quit()` → 向子进程发 `SIGTERM` → 等待优雅退出（兜底 5s 强杀）。

---

## 4. 打包后的目录结构

```
<安装目录 %LOCALAPPDATA%\Programs\DeepSeek Harness\>
├── DeepSeekHarness.exe              # Electron 主程序入口
├── resources\
│   ├── app.asar                     # Electron 壳代码（main.js 等）
│   ├── icon.ico                     # 应用/快捷方式图标
│   └── runtime\                     # ★ DSH 运行体（extraResources，不打包进 asar）
│       ├── node\                    # 便携 Node.js（node.exe + 运行库）
│       │   └── node.exe
│       └── dsh\                     # 原样搬运的 @deepseek-ai/dsh 安装目录
│           ├── lib\                 #   bin.js / profile-boot-*.js ...
│           ├── config\              #   agent-presets/{code,cordis,minimal,standard}
│           ├── package.json
│           └── node_modules\        #   ★ 完整运行时（裁剪后 ≈ 150–200MB）
└── data\                            # ★ DSH_HOME（可写；卸载随安装目录一并删除）
    ├── profiles\web\                #   首次启动生成/引导（cordis.yml 每次启动会被重写）
    ├── sessions\
    ├── storages\
    ├── settings.yaml
    └── .credentials.yaml
```

### 4.1 只读 / 可写边界（重要）

| 路径 | 属性 | 说明 |
|---|---|---|
| `resources\runtime\node` | 只读 | 便携 Node，spawn 用 |
| `resources\runtime\dsh\{lib,config,node_modules}` | 只读 | DSH 运行体；其中 `config/agent-presets` 由 boot 以只读「system trust」挂载 |
| `data\`（DSH_HOME） | **可写** | 必须在安装目录下（每用户安装 → 用户拥有写权限），卸载时整目录删除 |
| `data\profiles\web\cordis.yml` | 可写 | boot 每次启动都会 `writeFileSync` 重写它，因此 profiles 不能放只读区 |

> 若把 DSH_HOME 放在只读资源区，首次启动就会因无法重写 `cordis.yml` 失败。这是最容易踩的坑。

---

## 5. 技术选型

| 组件 | 选择 | 备注 |
|---|---|---|
| 桌面壳 | Electron 最新稳定版 | 主进程只做进程编排，无原生依赖，版本不敏感 |
| 服务端运行时 | 便携 Node.js **v24.x LTS** | 必须与生成 `node_modules` 的 Node 版本一致，保证原生 ABI 匹配 |
| 打包工具 | **electron-builder** | 原生支持 Windows EXE 安装器、per-user 安装、快捷方式、图标 |
| 安装器格式 | NSIS（electron-builder 默认） | 见下方 ⚠ 说明 |
| 架构 | x64（win32-x64） | 原生二进制只带 x64；arm64 后续再评估 |
| 图标/品牌 | 默认名「DeepSeek Harness」+ 默认图标 | 待替换后补正式图标 |

> ⚠ **关于「Inno Setup」的说明**：Electron 生态的标准单 EXE 安装器是 **NSIS**（electron-builder 内建），它在体验上与 Inno Setup 完全同类——单文件、每用户免管理员、可自定义图标与界面、自带卸载器。**推荐直接用 NSIS**。
> 若贵方有强制 Inno Setup 的规范，备选路径是：electron-builder 用 `dir` 目标产出「未打包目录」，再手工用 Inno Setup 包装该目录（多一步、多维护成本）。**此项请在评审时拍板**（默认走 NSIS）。

---

## 6. 分阶段实施步骤

### Phase 0 — 环境与物料准备

1. 构建机准备（Windows x64）：
   - Node.js **v24.x LTS**（与目标便携 Node 同版本）。
   - npm（含于 Node）。
   - Git。
2. 拉取运行体基线（二选一，推荐 ① 直接搬运当前已验证可用实例）：
   - ① 从已验证环境复制全局安装 `%APPDATA%\npm\node_modules\@deepseek-ai\dsh`（含其嵌套 `node_modules`）→ 作为 `runtime/dsh`。
   - ② 干净安装：`npm install @deepseek-ai/dsh@0.1.0-rc.6` 到 staging 目录，取其中的 `@deepseek-ai/dsh` 目录。
3. 下载便携 Node：`https://nodejs.org/dist/v24.x.x/node-v24.x.x-win-x64.zip`，解出 `node.exe` 等 → `runtime/node`。
   - **校验**：`runtime/node/node.exe -v` 必须等于第 2 步安装 node_modules 时所用 Node 的主版本。
4. 初始化 Electron 工程骨架（见 Phase 2）。

### Phase 1 — 构建 / 裁剪 DSH 运行体

1. 复制 `@deepseek-ai/dsh` 目录到 `build/runtime/dsh`。
2. 裁剪体积（目标 ≤ 200MB）：
   - 删除 `node_modules/.bin`、`node_modules/**/*.map`（如确定不需要 sourcemap）、`node_modules/**/prebuilds/{darwin-*,linux-*}`、`node_modules/node-pty/prebuilds/{darwin-*,win32-arm64}`、`node_modules/node-pty/third_party/**/{darwin,linux,win10-arm64}`。
   - 删除 `@img/sharp-*` 中非 win32-x64 平台包（若有）。
   - ⚠ 裁剪后**必须**在干净 VM 上冒烟验证，防止误删运行时依赖。
3. 记录体积基线，用于安装包大小预估（NSIS 压缩后预计 90–130MB）。

### Phase 2 — 编写 Electron 壳（`electron/main.js`）

核心逻辑（伪代码，实际按 Electron 版本用 CJS/ESM 落地）：

```js
const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const RESOURCES = process.resourcesPath;                 // <installDir>/resources
const NODE_EXE = path.join(RESOURCES, 'runtime', 'node', 'node.exe');
const DSH_BIN  = path.join(RESOURCES, 'runtime', 'dsh', 'lib', 'bin.js');
const DSH_HOME = path.join(path.dirname(RESOURCES), 'data'); // <installDir>/data

let proc = null, url = null, win = null, quitting = false;

function spawnServer() {
  return new Promise((resolve, reject) => {
    proc = spawn(NODE_EXE, [DSH_BIN, 'web', '--port', '0'], {
      env: { ...process.env, DSH_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const t = setTimeout(() => reject(new Error('服务启动超时(30s)')), 30000);
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += String(d);
      const m = buf.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/);
      if (m) { url = m[1]; clearTimeout(t); resolve(url); }
    });
    proc.stderr.on('data', (d) => console.error('[dsh]', String(d)));
    proc.on('exit', (code) => { clearTimeout(t); if (!quitting) fail(`DSH 退出(code ${code})`); });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, show: false,
    icon: path.join(RESOURCES, 'icon.ico'),
    title: 'DeepSeek Harness',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
  win.loadURL(url);
}

const ok = app.requestSingleInstanceLock();
if (!ok) { app.quit(); }
else {
  app.on('second-instance', () => { win && (win.isMinimized() ? win.restore() : win.focus()); });
  app.whenReady().then(async () => {
    try { await spawnServer(); createWindow(); maybeOnboard(); }
    catch (e) { dialog.showErrorBox('DeepSeek Harness 启动失败', String(e)); app.quit(); }
  });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { quitting = true; if (proc) { proc.kill('SIGTERM'); setTimeout(() => proc.kill(), 5000); } });
```

要点：
- **`--port 0`**：由 OS 分配空闲端口，彻底规避 3080 被占用；从 stdout 的 `dsh web: http://...` 解析真实端口，加载之。
- **`windowsHide: true`**：子进程不弹黑框。
- 窗口安全基线：`contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`。
- 外链：`setWindowOpenHandler` 一律 `shell.openExternal` 并用系统浏览器打开（不允许渲染进程任意新开窗口）。
- 生命周期：`before-quit` 先 `SIGTERM` 优雅关闭，5s 兜底强杀。

### Phase 3 — 首次运行 API Key 引导

DSH 的 Key 落点在 `$DSH_HOME/.credentials.yaml` 的 `DEEPSEEK_API_KEY`；模型/供应商由 Web「设置 → 模型」页写 `settings.yaml`。

引导策略（轻量，推荐）：

```js
function maybeOnboard() {
  const cred = path.join(DSH_HOME, '.credentials.yaml');
  const hasKey = fs.existsSync(cred) &&
                 /DEEPSEEK_API_KEY\s*:\s*\S+/.test(fs.readFileSync(cred, 'utf8'));
  if (hasKey) return;
  const r = dialog.showMessageBoxSync(win, {
    type: 'info', title: '欢迎使用 DeepSeek Harness',
    message: '首次使用：请先在「设置 → 模型」页配置 DeepSeek API Key。',
    detail: '获取地址：https://platform.deepseek.com （提交后本窗口自动加载设置页）',
    buttons: ['去设置', '稍后再说'], defaultId: 0,
  });
  if (r === 0) win.webContents.executeJavaScript(
    "location.hash = '/settings/models'") // 路由需在 Phase 3 用真实 UI 确认
}
```

- 若 Web 端设置页没有稳定可深链的 hash 路由，则退化为：对话框提示 + 用户点击应用内「设置」自行进入。
- 确认方法：在开发环境跑通 `dsh web` 后，进入「设置 → 模型」页，看地址栏 hash。

### Phase 4 — electron-builder 打包配置

`electron-builder.yml`（或 `package.json` 的 `build` 字段）关键内容：

```yaml
appId: com.deepseek.harness.desktop
productName: DeepSeek Harness
directories: { output: dist }
files:
  - electron/**/*
extraResources:
  - { from: build/runtime/node, to: runtime/node }
  - { from: build/runtime/dsh, to: runtime/dsh }
  - { from: build/icon.ico, to: icon.ico }
win:
  target: [{ target: nsis, arch: [x64] }]
  icon: build/icon.ico
nsis:
  oneClick: false
  perMachine: false                          # 每用户安装（%LOCALAPPDATA%）
  allowToChangeInstallationDirectory: true
  createDesktopShortcut: true
  createStartMenuShortcut: true
  shortcutName: DeepSeek Harness
  runAfterFinish: true                       # 安装完直接启动
  # 数据放安装目录，卸载即整目录删除，无需额外 deleteAppDataOnUninstall
```

要点：
- `extraResources`（而非打进 asar）承载 Node + DSH 运行体：原生 `.node` 无法从 asar 加载，spawn 也需要真实路径。
- `files` 只打包壳代码，避免把 `build/`、`node_modules`（壳自己的 devDeps）误打入 asar。

### Phase 5 — 构建与（可选）签名

1. `npx electron-builder --win` → 产出 `dist/DeepSeek Harness Setup 0.1.0-rc.6.exe`。
2. 首版未签名：SmartScreen 会提示，用户点「更多信息 → 仍要运行」。文档中注明此预期。
3. 后续签名（有证书后）：electron-builder 配置 `win.certificateFile / certificatePassword` + `signtoolOptions`（含 RFC3161 时间戳），再 `--publish`。

### Phase 6 — 测试清单（必须在干净 VM 上做）

- [ ] 全新 Windows 10/11 x64 VM，未装 Node/npm。
- [ ] 双击安装 → 无 UAC 弹窗 → 安装到 `%LOCALAPPDATA%\Programs\DeepSeek Harness`。
- [ ] 桌面/开始菜单快捷方式存在，图标正确。
- [ ] 双击快捷方式 → 窗口自动打开 → 加载 DSH 界面（样式与 Web 版逐项核对）。
- [ ] 首次运行出现 API Key 引导；配置 Key 后能正常发起对话。
- [ ] 端口占用场景：先占 3080 再启动 → 仍能自动选空闲端口正常打开。
- [ ] 单实例：二次双击 → 聚焦已有窗口，不重复起服务。
- [ ] 窗口关闭 → 服务进程退出（任务管理器无残留 node.exe）。
- [ ] 断网/无 Key 场景：界面能打开，仅模型请求报错，不崩溃。
- [ ] 卸载 → 安装目录（含 data 会话/凭据）整体清除，无残留文件/注册表。
- [ ] 重装后为全新状态（数据已按设计清空）。
- [ ] （可选）遥测开关：设置 `DSH_TELEMETRY_DISABLED=1` 验证不报。

### Phase 7 — 发布与更新

- v1：静态 EXE 随版本号人工分发。
- 后续：接入 electron-updater + 静态文件服务器做增量更新；接入 EV 签名消除 SmartScreen 提示。

---

## 7. 关键风险与对策

| # | 风险 | 影响 | 对策 |
|---|---|---|---|
| 1 | 便携 Node 与 `node_modules` 原生 ABI 不匹配 | 起服崩溃 | 硬性规则：**安装 node_modules 的 Node 版本 == 打包的便携 Node 版本**；构建机固化版本并在 CI 校验 `node.exe -v` |
| 2 | `cordis.yml` 需可写却被放只读区 | 首次启动失败 | DSH_HOME 必须落在安装目录可写区（§4.1） |
| 3 | 端口 3080 被占用 | 打不开 | 用 `--port 0` + 解析 stdout URL，彻底规避 |
| 4 | 未签名触发 SmartScreen | 用户困惑 | 首版文档写明绕过路径；后续上证书 |
| 5 | API Key 明文存安装目录 | 凭据泄露（本机其他进程可读） | 已接受（用户选「数据放安装目录」）；文档标注该安全边界；后续可评估 DPAPI 加密 |
| 6 | 裁剪 node_modules 误删依赖 | 运行时缺包 | 裁剪后必须在干净 VM 全流程冒烟；CI 增加「干净 VM 安装+启动+对话」门禁 |
| 7 | LAN 暴露 / RCE | 严重 | 保持 loopback 绑定，不传 `--host 0.0.0.0`（DSH 本身也拒绝） |
| 8 | 第三方许可 / 商标 | 合规 | 生成第三方 licenses 清单随包附带；公开分发前确认 DeepSeek 商标与产品命名口径 |
| 9 | 壳代码被打进 asar 后 spawn 失败 | 起不了服务 | 运行体一律走 `extraResources`，spawn 用 `process.resourcesPath` 解析绝对路径 |
| 10 | 遥测默认上报 | 隐私 | 评审是否默认 `DSH_TELEMETRY_DISABLED=1`，或安装时提供开关 |

---

## 8. 验收标准（Definition of Done）

在**干净 Windows 10/11 x64 VM（无 Node 环境）**上逐条通过：

1. 单 EXE 安装，免管理员，无 UAC。
2. 桌面双击 → 自动打开窗口并加载出与 Web 版**像素级一致**的界面，无需任何命令行操作。
3. 首次运行有 API Key 引导；配置后可完成一轮真实对话。
4. 端口冲突、二次启动、断网三种场景行为符合 §7 预期。
5. 卸载后安装目录彻底清除（含会话与凭据），无残留进程/文件。
6. 安装包体积与启动耗时在可接受范围（建议：安装包 ≤ 150MB，冷启动到窗口可见 ≤ 15s）。

---

## 9. 遗留待确认项

1. **安装器格式**：默认走 electron-builder **NSIS**（与 Inno Setup 同体验）；若必须 Inno Setup，改用 `dir` 产物二次包装。请拍板。
2. **品牌名与图标**：暂用「DeepSeek Harness」+ 默认图标，请提供正式名称与 `.ico`（256×256 多层）。
3. **遥测默认值**：是否默认关闭（`DSH_TELEMETRY_DISABLED=1`）？
4. **安装语言**：默认简体中文，是否需中英双语。
5. **DSH 版本基线**：锁定 `0.1.0-rc.6`，还是等正式 release 版再出第一个安装包。
6. **首次引导深链**：设置页 hash 路由需在实施时以真实 UI 确认（§Phase 3）。
