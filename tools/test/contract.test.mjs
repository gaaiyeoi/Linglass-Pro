/**
 * 契约测试 —— 断言我们对 Linglass 官方产物的全部依赖仍然成立。
 *
 * 为什么需要它：src/mod/ 的功能全部寄生在官方产物之上（字幕浮层的 Shadow DOM class、
 * YouTube 控制栏的选择器、设置面板的 class 名……）。官方一发新版，这些记号可能静默
 * 消失，表现为「字幕不动了」而不是抛错。这份测试把这种失效从「打开视频手动发现」
 * 提前到「make test 直接失败」。
 *
 * 两条断言：
 *   1. 契约表里的每个记号都还能在官方产物里找到 —— 官方改版检测。
 *   2. 源码里以 '.xxx' / '#xxx' 写法出现的每个选择器都已登记 —— 漏登记检测。
 *      新增对官方 DOM 的依赖却忘了登记时，测试会把那个选择器直接报出来。
 *
 * 第 2 条的覆盖边界（诚实说明）：只能扫到「字符串字面量里带 . / # 前缀」的选择器。
 * 源码里还有一批是 className 赋值式写法（例如 row.className = 'toggle-row'），它们不带
 * 前缀，扫不出来，只能靠契约表手工维护。也就是说漏登记检测是补充，不是替代。
 *
 * 平台契约（YouTube 页面结构与浏览器 API）不属于官方产物，无法对 vendor 断言，
 * 因此单列一张表，只用于让漏登记检测放过它们，并留下「我们依赖哪些外部结构」的记录。
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VENDOR_DIR = path.join(ROOT, 'vendor');
const SRC_MOD = path.join(ROOT, 'src', 'mod');

/**
 * Linglass 官方产物的契约记号。
 *
 * probe    必须能在官方产物里找到的字符串
 * selector 我们在源码里的原样写法；null 表示源码用的是 className 赋值式，扫不到
 * where    源码位置，便于改版时定位
 * note     这条依赖是干什么的
 */
const LINGLASS_CONTRACT = [
  {
    probe: 'linglass-subtitle-overlay',
    selector: null,
    where: '10-subtitle-track.js HOST_ID',
    note: '字幕浮层宿主 id，读取字幕的唯一入口',
  },
  {
    probe: 'subtitle-group',
    selector: '.subtitle-group',
    where: '10-subtitle-track.js readLines()',
    note: '字幕容器；display:none 时表示当前无字幕',
  },
  {
    probe: 'subtitle-primary',
    selector: '.subtitle.subtitle-primary',
    where: '10-subtitle-track.js readLines()',
    note: '原文行',
  },
  {
    probe: 'subtitle-secondary',
    selector: '.subtitle.subtitle-secondary',
    where: '10-subtitle-track.js readLines()',
    note: '译文行',
  },
  {
    probe: 'linglass-word',
    selector: null,
    where: '（待用）逐词渲染',
    note: '词级 span，仅在官方拿到分段时生成；逐词进度要靠它',
  },
  {
    probe: '.ytp-right-controls',
    selector: '.ytp-right-controls',
    where: '00-shared.js ensureButton()',
    note: '控制栏右侧容器，我们所有按钮的挂载点',
  },
  {
    probe: 'linglass-settings-btn',
    selector: '.linglass-settings-btn',
    where: '00-shared.js place()',
    note: '官方设置按钮，我们的按钮紧跟它插入',
  },
  {
    probe: 'linglass-settings-panel-v2',
    selector: null,
    where: '50-settings-panel.js HOST_ID',
    note: '官方设置面板宿主 id',
  },
  {
    probe: 'panel-pages',
    selector: '.panel-pages',
    where: '50-settings-panel.js inject()',
    note: '面板分页容器，用来判断面板是否已渲染完成',
  },
  {
    probe: 'panel-page',
    selector: '.panel-content.panel-page[data-page="root"]',
    where: '50-settings-panel.js ROOT_PAGE',
    note: 'root 页容器；我们的行挂在它下面',
  },
  {
    probe: 'data-page',
    selector: null,
    where: '50-settings-panel.js ROOT_PAGE',
    note: '分页标识属性',
  },
  {
    probe: 'section-label',
    selector: null,
    where: '50-settings-panel.js 分组标题',
    note: '分组标题样式',
  },
  {
    probe: 'toggle-section',
    selector: null,
    where: '50-settings-panel.js 开关分组',
    note: '开关分组容器',
  },
  {
    probe: 'toggle-row',
    selector: null,
    where: '50-settings-panel.js buildToggleRow()',
    note: '开关行；用对 class 才白拿官方样式',
  },
  {
    probe: 'toggle-label',
    selector: null,
    where: '50-settings-panel.js buildToggleRow()',
    note: '开关行文案区',
  },
  {
    probe: 'toggle-knob',
    selector: null,
    where: '50-settings-panel.js buildToggleRow()',
    note: '开关滑块',
  },
  {
    probe: 'nav-row',
    selector: null,
    where: '50-settings-panel.js buildActionRow()',
    note: '操作行',
  },
  {
    probe: 'nav-row__name',
    selector: null,
    where: '50-settings-panel.js buildActionRow()',
    note: '操作行标题',
  },
  {
    probe: 'nav-row__val',
    selector: null,
    where: '50-settings-panel.js buildActionRow()',
    note: '操作行右侧数值',
  },
  {
    probe: 'data-tooltip-text',
    selector: null,
    where: '00-shared.js CONTROL_CSS 的 ::after',
    note: '官方自绘气泡用的属性名，我们沿用同一套',
  },
];

/** 平台契约：YouTube 的 DOM 与浏览器 API，不属于官方产物，仅登记 */
const PLATFORM_CONTRACT = [
  { probe: '#movie_player video', where: '10-subtitle-track.js / 40-study-panel.js', note: 'YouTube 播放器里的 video 元素' },
  { probe: '#owner #channel-name a', where: '10-subtitle-track.js readMeta()', note: '频道名（旧版 DOM）' },
  { probe: 'ytd-watch-metadata', where: '10-subtitle-track.js readMeta()', note: '视频元信息容器（新版 DOM）' },
  { probe: 'yt-navigate-finish', where: '10-subtitle-track.js / 40-study-panel.js', note: 'YouTube SPA 换视频事件' },
  { probe: 'documentPictureInPicture', where: '30-desktop-subtitles.js', note: '系统级画中画 API（Chromium 116+）' },
];

/** 我们自己的选择器与颜色字面量，不参与官方改版检测 */
const SELF_OWNED = [
  '.row.is-active', // 学习面板列表的当前句高亮，面板在 shadow DOM 内，与官方无关
];

/** 形如 #fff / #0A84FF 的颜色字面量，长得像 id 选择器，要排除 */
function isColorLiteral(token) {
  return /^#[0-9a-fA-F]{3,8}$/.test(token);
}

/** 取 vendor/ 下版本号最大的 linglass-* 目录 */
async function pickVendor() {
  const dirs = (await readdir(VENDOR_DIR, { withFileTypes: true }))
    .filter((e) => e.isDirectory() && e.name.startsWith('linglass-'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  if (!dirs.length) throw new Error('vendor/ 下找不到 linglass-* 目录，先跑 make vendor-update');
  return path.join(VENDOR_DIR, dirs[dirs.length - 1]);
}

/**
 * 把官方产物拼成一个 haystack。
 *
 * 不按文件名去猜 —— 官方一发版哈希就变，且实测契约记号会散落在名字有误导性的共享
 * chunk 里（例如字幕覆盖层的样式在 promoCards-*.js）。所以只关心「某个记号在不在
 * 产物里」，不关心它在哪个文件。
 */
async function buildHaystack(vendor) {
  const parts = [];
  const assets = path.join(vendor, 'assets');

  for (const file of await readdir(assets)) {
    if (!file.endsWith('.js') && !file.endsWith('.css')) continue;
    parts.push(await readFile(path.join(assets, file), 'utf8'));
  }

  // 非 assets/ 下的产物也要算：侧边栏 HTML、页面级 CSS、站点 hook、manifest
  for (const rel of [
    'manifest.json',
    'src/sidepanel/sidepanel.html',
    'src/content/translate/styles.css',
    'src/content/netflix/manifestHook.js',
    'src/content/viki/vikiHook.js',
  ]) {
    try {
      parts.push(await readFile(path.join(vendor, rel), 'utf8'));
    } catch {
      // 官方某个版本没有这个文件就算了，不影响主要契约
    }
  }

  return parts.join('\n');
}

/**
 * 从源码里扫出「疑似选择器」的字符串字面量。
 *
 * 只扫单引号字面量：src/mod/ 全用单引号写选择器（与项目其余代码一致）。
 * 允许字面量内部含双引号，因为 '.panel-content.panel-page[data-page="root"]' 这种
 * 带属性值的写法是存在的。
 */
function extractSelectors(source) {
  const found = new Set();
  const literal = /'((?:[.#][\w.#=[\]"-]*)(?: [\w.#=[\]"-]+)*)'/g;
  let match;
  while ((match = literal.exec(source)) !== null) {
    if (/[.#][A-Za-z]/.test(match[1])) found.add(match[1]);
  }
  return found;
}

test('官方产物里还能找到全部契约记号', async () => {
  const vendor = await pickVendor();
  const haystack = await buildHaystack(vendor);

  const missing = LINGLASS_CONTRACT.filter((c) => !haystack.includes(c.probe));
  assert.deepEqual(
    missing.map((c) => `${c.probe}  (${c.where} —— ${c.note})`),
    [],
    `官方可能改版：下列记号在 ${path.basename(vendor)}/ 里找不到。` +
      '构建仍会成功，但对应功能会在运行时失效，请核对选择器。',
  );
});

test('源码里出现的每个选择器都已登记', async () => {
  const files = (await readdir(SRC_MOD)).filter((f) => f.endsWith('.js'));
  assert.notEqual(files.length, 0, 'src/mod/ 下没有源码文件');

  const found = new Set();
  for (const file of files) {
    const source = await readFile(path.join(SRC_MOD, file), 'utf8');
    for (const selector of extractSelectors(source)) found.add(selector);
  }

  const declared = new Set([
    ...LINGLASS_CONTRACT.map((c) => c.selector).filter(Boolean),
    ...PLATFORM_CONTRACT.map((c) => c.probe),
    ...SELF_OWNED,
  ]);

  const unknown = [...found].filter((s) => !declared.has(s) && !isColorLiteral(s));
  assert.deepEqual(
    unknown,
    [],
    '下列选择器既不在官方契约表、也不在平台契约表里。新增对官方 DOM 的依赖时，' +
      '请到 tools/test/contract.test.mjs 登记，否则官方改版时它不会被发现。',
  );
});

test('契约表里没有重复登记的记号', () => {
  const probes = [...LINGLASS_CONTRACT, ...PLATFORM_CONTRACT].map((c) => c.probe);
  const seen = new Set();
  const dupes = probes.filter((p) => (seen.has(p) ? true : (seen.add(p), false)));
  assert.deepEqual(dupes, [], '同一记号登记了多次');
});
