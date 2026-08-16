'use strict';

/**
 * DeepSeek Harness — Windows 桌面壳（Electron 主进程）
 *
 * 职责：单实例锁 → spawn 便携 Node 跑 `dsh web --port 0` → 解析就绪 URL
 *       → 打开 BrowserWindow 承载 Web UI → 首次运行引导 API Key → 退出时回收子进程。
 *
 * 关键设计：DSH 服务端始终运行在标准便携 Node 上（避免 Electron ABI 差异），
 * 本文件只做进程编排，不加载任何原生模块。
 */

const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

app.setAppUserModelId('com.deepseek.harness.desktop');

// ---- 路径解析（开发 / 打包两态） ----
const isPackaged = app.isPackaged;

// 运行体根目录：打包后位于 <installDir>/resources，开发时位于项目 build/
const RESOURCES = isPackaged
  ? process.resourcesPath
  : path.join(__dirname, '..', 'build');

const NODE_EXE = path.join(RESOURCES, 'runtime', 'node', 'node.exe');
const DSH_BIN = path.join(RESOURCES, 'runtime', 'dsh', 'lib', 'bin.js');

// 可写数据目录 DSH_HOME：打包后位于 <installDir>/data（卸载随安装目录删除），开发时位于项目 .dev-home/
const DSH_HOME = isPackaged
  ? path.join(path.dirname(process.resourcesPath), 'data')
  : path.join(__dirname, '..', '.dev-home');

// 窗口图标：打包后由 EXE 内嵌图标承担；开发态显式指向项目内的 .ico
const WINDOW_ICON = isPackaged
  ? undefined
  : path.join(__dirname, '..', 'DeepSeekHarness-WhaleGirl.ico');

// ---- 可调开关 ----
// 默认关闭遥测（本地工具、隐私优先）；设 DSH_DESKTOP_ENABLE_TELEMETRY=1 恢复 DSH 默认上报
const TELEMETRY_ENV =
  process.env.DSH_DESKTOP_ENABLE_TELEMETRY === '1'
    ? {}
    : { DSH_TELEMETRY_DISABLED: '1' };

const SERVER_START_TIMEOUT_MS = 30 * 1000;

// ---- 运行状态 ----
let serverProc = null;
let serverUrl = null;
let mainWindow = null;
let quitting = false;

function fail(message) {
  dialog.showErrorBox('DeepSeek Harness 启动失败', message);
  app.quit();
}

/** 拉起 DSH 服务子进程，返回解析出的回环 URL。 */
function spawnServer() {
  return new Promise((resolve, reject) => {
    serverProc = spawn(NODE_EXE, [DSH_BIN, 'web', '--port', '0'], {
      env: { ...process.env, ...TELEMETRY_ENV, DSH_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    const timer = setTimeout(() => {
      reject(new Error(`服务启动超时（${SERVER_START_TIMEOUT_MS / 1000}s）`));
    }, SERVER_START_TIMEOUT_MS);

    let out = '';
    serverProc.stdout.on('data', (chunk) => {
      out += String(chunk);
      const m = out.match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    serverProc.stderr.on('data', (chunk) => {
      process.stderr.write(`[dsh] ${chunk}`);
    });
    serverProc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    serverProc.on('exit', (code) => {
      clearTimeout(timer);
      if (!quitting) {
        fail(`DSH 服务已退出（code ${code === null ? 'unknown' : code}）`);
      }
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'DeepSeek Harness',
    icon: WINDOW_ICON,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    // 窗口可见后再弹首次引导，避免父窗口未就绪导致对话框定位异常
    maybeOnboard();
  });

  // 页面新开窗口一律交给系统浏览器
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(serverUrl);
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** 首次运行：若未配置 DeepSeek API Key，弹原生引导对话框。 */
function maybeOnboard() {
  try {
    const credPath = path.join(DSH_HOME, '.credentials.yaml');
    if (!fs.existsSync(credPath)) return showOnboarding();
    const text = fs.readFileSync(credPath, 'utf8');
    const line = text
      .split(/\r?\n/)
      .find((l) => /^\s*DEEPSEEK_API_KEY\s*:/.test(l));
    if (!line) return showOnboarding();
    const value = line.replace(/^\s*DEEPSEEK_API_KEY\s*:\s*/, '').trim();
    const normalized = value.replace(/^['"]|['"]$/g, '').trim();
    if (normalized === '') showOnboarding();
  } catch {
    showOnboarding();
  }
}

function showOnboarding() {
  const result = dialog.showMessageBoxSync(mainWindow, {
    type: 'info',
    title: '欢迎使用 DeepSeek Harness',
    message: '首次使用：请先在「设置 → 模型」中配置 DeepSeek API Key。',
    detail:
      '获取 Key：https://platform.deepseek.com\n\n' +
      '配置完成后即可开始对话。也可稍后在应用左下角「设置」中随时修改。',
    buttons: ['我知道了', '打开设置页'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  // 设置页深链路由随版本可能变化，稳健起见仅提示；此处保留软导航尝试（失败无害）
  if (result === 1 && mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents
        .executeJavaScript(
          "(() => { const h = location.hash || ''; if (!/settings/i.test(h)) location.hash = '#/settings'; return true; })()"
        )
        .catch(() => {});
    } catch {
      /* 忽略 */
    }
  }
}

// ---- 应用生命周期 ----
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      serverUrl = await spawnServer();
      createWindow();
    } catch (err) {
      fail(err && err.message ? err.message : String(err));
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && serverUrl) createWindow();
  });
}

app.on('window-all-closed', () => {
  // 关窗即退出（v1 不做托盘驻留）
  app.quit();
});

app.on('before-quit', () => {
  quitting = true;
  if (serverProc && !serverProc.killed) {
    // Windows 上 child.kill() 为强制终止；DSH 会话数据按事件持续落盘，风险可忽略。
    try {
      serverProc.kill();
    } catch {
      /* 已退出 */
    }
  }
});
