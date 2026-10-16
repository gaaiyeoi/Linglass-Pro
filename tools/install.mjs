#!/usr/bin/env node
/**
 * 一键安装器（面向非技术用户）
 *
 * 由发布包根目录的 install-macos.command / install-windows.bat 调用，
 * 手工在终端里跑也行：node tools/install.mjs
 *
 * 做三件事：
 *   1. 从 Chrome 商店下载官方基线到 vendor/（用户本机自己拉，发布包不含官方代码）
 *   2. 调 build.mjs 把 src/mod/ 叠加成 dist/
 *   3. 打开浏览器扩展管理页 + 在文件管理器里高亮 dist/，并弹出自包含的图文向导
 *
 * 之后的「开启开发者模式 → 加载已解压的扩展程序 → 选 dist/」是 Chrome 的安全边界，
 * 没有任何脚本能代劳 —— 所以最后一步必须由人来点，向导里写清了点哪里。
 *
 * 注意：本文件被 import 时不会执行任何动作（见文件末尾的守卫），
 * 因为 tools/test/install.test.mjs 要单独测下面的 browserCandidates()。
 */
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 低于这个版本跑不了 node:test / 全局 fetch / zlib 用法 */
const REQUIRED_NODE_MAJOR = 18;

/** 发布包必须齐备的文件（缺了说明用户跑错了目录，或者包解漏了） */
const PACKAGE_ENTRIES = ['build.mjs', 'src/mod', 'tools/import-vendor.mjs'];

const GUIDE = path.join('docs', 'install-guide.html');
const DIST = path.join(ROOT, 'dist');

function log(msg) {
  console.log(`[install] ${msg}`);
}

function fail(msg) {
  console.error(`\n[install] ✖ ${msg}\n`);
  process.exit(1);
}

/**
 * 候选浏览器，按探测优先级排列。
 *
 * 纯数据（不碰文件系统），路径交给 pickBrowser() 里的 existsSync 过滤 ——
 * 这样这张表在任意平台上都能被单测断言，不需要真装五个浏览器。
 */
export function browserCandidates(platform, env = process.env) {
  if (platform === 'darwin') {
    return [
      { name: 'Google Chrome', app: '/Applications/Google Chrome.app', url: 'chrome://extensions' },
      { name: 'Arc', app: '/Applications/Arc.app', url: 'arc://extensions' },
      { name: 'Microsoft Edge', app: '/Applications/Microsoft Edge.app', url: 'chrome://extensions' },
      { name: 'Brave Browser', app: '/Applications/Brave Browser.app', url: 'chrome://extensions' },
      { name: 'Chromium', app: '/Applications/Chromium.app', url: 'chrome://extensions' },
    ];
  }

  if (platform === 'win32') {
    // 显式用 win32 分隔符：这张表在任意平台上取用时都该是 Windows 路径，
    // 否则在 macOS 上跑单测会拼出 `C:\Program Files/Google/…` 这种混合串
    const win = path.win32.join;
    const pf = env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const local = env.LOCALAPPDATA ?? win('C:\\Users', 'Default', 'AppData', 'Local');
    return [
      {
        name: 'Google Chrome',
        app: win(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        url: 'chrome://extensions',
      },
      {
        name: 'Google Chrome（只装了当前用户）',
        app: win(local, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        url: 'chrome://extensions',
      },
      {
        name: 'Arc',
        app: win(local, 'Programs', 'Arc', 'Arc.exe'),
        url: 'arc://extensions',
      },
      {
        name: 'Microsoft Edge',
        app: win(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        url: 'chrome://extensions',
      },
      {
        name: 'Google Chrome（32 位目录）',
        app: win(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        url: 'chrome://extensions',
      },
    ];
  }

  // Linux：不猜测安装路径，交给 PATH 里的命令名（探测失败就只提示用户手动打开）
  return [
    { name: 'Google Chrome', app: 'google-chrome', url: 'chrome://extensions', viaPath: true },
    { name: 'Chromium', app: 'chromium', url: 'chrome://extensions', viaPath: true },
    { name: 'Microsoft Edge', app: 'microsoft-edge', url: 'chrome://extensions', viaPath: true },
    { name: 'Brave Browser', app: 'brave-browser', url: 'chrome://extensions', viaPath: true },
  ];
}

/** 挑第一个真的装了的浏览器；一个都没找到返回 null（不报错，由调用方降级提示） */
function pickBrowser() {
  for (const candidate of browserCandidates(process.platform)) {
    if (candidate.viaPath) return candidate;
    if (existsSync(candidate.app)) return candidate;
  }
  return null;
}

/** 打开浏览器扩展页：macOS 走 open -a，其余平台直接拉起可执行文件 */
function openBrowser(candidate) {
  if (process.platform === 'darwin') {
    spawn('open', ['-a', candidate.app, candidate.url], { stdio: 'ignore' }).unref();
    return;
  }
  spawn(candidate.app, [candidate.url], { detached: true, stdio: 'ignore' }).unref();
}

/** 在系统文件管理器里高亮 dist/，省得用户自己去翻「下载」目录 */
function revealDir(dir) {
  if (process.platform === 'darwin') {
    spawn('open', ['-R', dir], { stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'win32') {
    spawn('explorer', [dir], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [dir], { detached: true, stdio: 'ignore' }).unref();
}

/** 用系统默认程序打开一个本地文件（图文向导） */
function openFile(file) {
  if (process.platform === 'darwin') {
    spawn('open', [file], { stdio: 'ignore' }).unref();
    return;
  }
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', file], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
}

/** 跑一个子脚本，日志直接透传到用户眼前；失败即抛 */
function runStep(label, script, args) {
  log(`▶ ${label}`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} 失败（退出码 ${code}）`));
    });
  });
}

async function checkPackageLayout() {
  const missing = [];
  for (const entry of PACKAGE_ENTRIES) {
    try {
      await access(path.join(ROOT, entry));
    } catch {
      missing.push(entry);
    }
  }
  if (missing.length) {
    fail(
      `这个目录不像安装包（少了 ${missing.join('、')}）。\n` +
      `        请先完整解压下载的压缩包，再双击里面的安装文件。\n` +
      `        当前目录：${ROOT}`,
    );
  }
}

function printNextSteps(browserName) {
  const label = browserName ?? '你的浏览器';
  console.log(`
------------------------------------------------------------
 还差 4 下点击（Chrome 不允许任何程序替你做这步）：

   1. 在打开的 ${label} 里，点右上角「开发者模式」开关
   2. 点左上角「加载已解压的扩展程序」
   3. 选这个文件夹：${DIST}
      （我已经在文件管理器里帮你选中它了）
   4. 看到 Linglass-Pro 出现，去 YouTube 打开任意带字幕的视频

 详细图文（含截图说明）已经用浏览器打开了：${GUIDE}
 装完想删掉：在扩展管理页点「移除」即可，不留残留。
------------------------------------------------------------
`);
}

async function main() {
  console.log('');
  log('Linglass-Pro 一键安装');
  log(`目录    ${ROOT}`);
  log(`Node    ${process.version}`);
  console.log('');

  if (Number(process.versions.node.split('.')[0]) < REQUIRED_NODE_MAJOR) {
    fail(`需要 Node.js ${REQUIRED_NODE_MAJOR} 或更新版本，当前是 ${process.version}。请到 nodejs.org 装新版本后再双击一次。`);
  }

  await checkPackageLayout();

  try {
    log('第 1 / 3 步：从 Chrome 商店下载官方基线（本机自己拉，安装包里不含官方代码）');
    console.log('');
    await runStep('下载官方基线', 'tools/import-vendor.mjs', ['--download']);

    console.log('');
    log('第 2 / 3 步：叠加本项目的改造，生成 dist/');
    console.log('');
    await runStep('构建 dist/', 'build.mjs', []);

    console.log('');
    log('第 3 / 3 步：打开该打开的页面');
  } catch (err) {
    fail(
      `${err.message}\n` +
      '        常见原因：网络不通（第 1 步要联网）、磁盘空间不足、或者杀毒软件拦了写入。\n' +
      `        重试：再双击一次安装文件即可，已下载的部分会跳过。`,
    );
  }

  const candidate = pickBrowser();
  if (candidate) {
    openBrowser(candidate);
    log(`已尝试打开 ${candidate.name} 的扩展管理页`);
  } else {
    log('没找到已安装的 Chrome / Arc / Edge，请自己打开浏览器的扩展管理页');
  }

  revealDir(DIST);

  const guide = path.join(ROOT, GUIDE);
  if (existsSync(guide)) {
    openFile(guide);
  } else {
    log(`图文向导文件缺失（${GUIDE}），请照着下面终端里的步骤做`);
  }

  printNextSteps(candidate ? candidate.name : null);

  // 版本号让用户能对上发布页的说明
  try {
    const manifest = JSON.parse(await readFile(path.join(DIST, 'manifest.json'), 'utf8'));
    log(`构建完成，产物版本 ${manifest.version}`);
  } catch {
    // 读不到就算了 —— 上面 build.mjs 已经自检过了
  }
}

/** 只在被直接执行时跑 main（被 import 时什么都不做，方便单测纯函数） */
const invokedDirectly = process.argv[1]
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    fail(err.message);
  });
}
