#!/usr/bin/env node
/**
 * 安装脚本
 *
 * 由发布包根目录的 install-macos.command / install-windows.bat 调用，
 * 也可以在终端中直接执行：node tools/install.mjs
 *
 * 执行流程：
 *   1. 从 Chrome 商店下载 Linglass 当前版本到 vendor/
 *   2. 调用 build.mjs 将 src/mod/ 合并为 dist/
 *   3. 打开浏览器扩展管理页，在文件管理器中定位 dist/，并打开图文向导
 *
 * 「启用开发者模式 → 加载已解压的扩展程序 → 选择 dist/」需要在浏览器中手动完成。
 * 本文件被 import 时不执行任何操作，以便测试 browserCandidates()。
 */
import { spawn } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 运行所需的最低 Node.js 版本 */
const REQUIRED_NODE_MAJOR = 18;

/** 发布包必须包含的文件；缺失表示目录不正确或包未完整解压 */
const PACKAGE_ENTRIES = ['build.mjs', 'src/mod', 'tools/import-vendor.mjs'];

const GUIDE = path.join('docs', 'install-guide.html');
const DIST = path.join(ROOT, 'dist');

function log(msg) {
  console.log(`[install] ${msg}`);
}

function fail(msg) {
  console.error(`\n[install] 错误：${msg}\n`);
  process.exit(1);
}

/**
 * 候选浏览器，按探测优先级排列。
 *
 * 该函数只返回数据，不访问文件系统；路径是否存在由 pickBrowser() 检查。
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
    // 使用 win32 分隔符，保证在任意平台上返回的路径格式一致
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

  // Linux 不猜测安装路径，使用 PATH 中的命令名
  return [
    { name: 'Google Chrome', app: 'google-chrome', url: 'chrome://extensions', viaPath: true },
    { name: 'Chromium', app: 'chromium', url: 'chrome://extensions', viaPath: true },
    { name: 'Microsoft Edge', app: 'microsoft-edge', url: 'chrome://extensions', viaPath: true },
    { name: 'Brave Browser', app: 'brave-browser', url: 'chrome://extensions', viaPath: true },
  ];
}

/** 返回第一个已安装的浏览器；未找到时返回 null */
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

/** 在系统文件管理器中定位 dist/ */
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
  log(`执行：${label}`);
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
      `当前目录不是完整的安装包，缺少：${missing.join('、')}。\n` +
      `        请先完整解压下载的压缩包，再双击其中的安装文件。\n` +
      `        当前目录：${ROOT}`,
    );
  }
}

function printNextSteps(browserName) {
  const label = browserName ?? '浏览器';
  console.log(`
------------------------------------------------------------
 还差 4 步，需要在浏览器中手动完成：

   1. 在 ${label} 中启用右上角「开发者模式」
   2. 点击左上角「加载已解压的扩展程序」
   3. 选择以下目录：${DIST}
      该目录已在文件管理器中选中
   4. 确认 Linglass-Pro 出现在扩展列表，然后在 YouTube 打开任意带字幕的视频

 图文说明已在浏览器中打开：${GUIDE}
 卸载：在扩展管理页点击「移除」，随后删除安装目录。
------------------------------------------------------------
`);
}

async function main() {
  console.log('');
  log('Linglass-Pro 安装');
  log(`目录    ${ROOT}`);
  log(`Node    ${process.version}`);
  console.log('');

  if (Number(process.versions.node.split('.')[0]) < REQUIRED_NODE_MAJOR) {
    fail(`需要 Node.js ${REQUIRED_NODE_MAJOR} 或更新版本，当前版本为 ${process.version}。请安装新版本后重新运行安装文件。`);
  }

  await checkPackageLayout();

  try {
    log('第 1 / 3 步：从 Chrome 商店获取 Linglass 当前版本');
    console.log('');
    await runStep('获取 Linglass 基线', 'tools/import-vendor.mjs', ['--download']);

    console.log('');
    log('第 2 / 3 步：与 src/mod/ 合并，生成 dist/');
    console.log('');
    await runStep('构建 dist/', 'build.mjs', []);

    console.log('');
    log('第 3 / 3 步：打开扩展管理页与图文向导');
  } catch (err) {
    fail(
      `${err.message}\n` +
      '        可能原因：网络不可用、磁盘空间不足，或写入被安全软件拦截。\n' +
      `        可重新运行安装文件重试，已下载的部分会跳过。`,
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
