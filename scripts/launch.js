// 无 Electron 冒烟启动器（开发验证用）：
// spawn 便携 Node 跑 `dsh web --port 0`，解析就绪 URL 后用系统默认浏览器打开。
// 生产环境由 electron/main.js 承载同样的 spawn + 解析逻辑。
'use strict';

const { spawn, exec } = require('node:child_process');
const path = require('node:path');

const RESOURCES = path.join(__dirname, '..', 'build');
const NODE_EXE = path.join(RESOURCES, 'runtime', 'node', 'node.exe');
const DSH_BIN = path.join(RESOURCES, 'runtime', 'dsh', 'lib', 'bin.js');
const DSH_HOME = process.env.DSH_HOME || path.join(__dirname, '..', '.dev-home');

if (!require('node:fs').existsSync(NODE_EXE) || !require('node:fs').existsSync(DSH_BIN)) {
  console.error('运行体未组装，请先执行: npm run build:runtime');
  process.exit(2);
}

const proc = spawn(NODE_EXE, [DSH_BIN, 'web', '--port', '0'], {
  env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_HOME },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let out = '';
proc.stdout.on('data', (d) => {
  out += String(d);
  process.stdout.write(d);
  const m = out.match(/dsh web:\s*(http:\/\/127\.0\.0\.1:\d+)/);
  if (m) {
    console.log(`\n[launcher] 就绪: ${m[1]}，正在打开默认浏览器...`);
    exec(`start "" "${m[1]}"`, { shell: 'cmd.exe' });
  }
});
proc.stderr.on('data', (d) => process.stderr.write(d));
proc.on('exit', (code) => process.exit(code === null ? 0 : code));
