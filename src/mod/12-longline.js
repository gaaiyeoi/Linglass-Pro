/**
 * 长句排版优化（视频内官方字幕行）
 *
 * 日语难度调高后，一句字幕动辄 40 个字符以上。官方那行的可用宽度只有播放器的
 * 85.5%（overlay width 95% × primary max-width 90%），于是长句会折成两三行；
 * 而日文没有空格、官方也没写禁则，断点会落在词或假名中间 —— 读起来就像"断了"。
 *
 * 这里只往官方字幕的 shadowRoot 注入一小段**排版**样式，不动 DOM 结构、不动文本：
 *   · overlay 95% → 98%，primary / secondary max-width 90% → 96%
 *     （一行上限 85.5% → ≈94%，多 3～5 个假名）；
 *   · line-break: strict —— 按日文禁则断行，不让小假名、开括号、标点落在行首；
 *   · text-wrap: balance —— 实在要折两行时两行长度接近，而不是「第一行满、第二行两个字」。
 *
 * 为什么不动字号：字号由官方的 subtitleScale 决定（浮窗的 Aa 与官方设置面板都在写它），
 * 这里再乘一个系数会让两处显示不一致，也会让用户觉得「明明设了 100% 却变小了」。
 *
 * 为什么不插 <wbr> + word-break: keep-all：那能保证只在文节边界断行，但要往官方行里插
 * 节点，而 keep-all 在无空格日语里可能让整句不可断、直接溢出。断点只交给 CSS 禁则，
 * 收益与风险更匹配（同一套顾虑见 15-ja-break.js 的文件头）。
 *
 * 幂等：样式已在就不写；官方重建浮层时由共享心跳补回来（PLAN 025 的唯一 1s 定时器）。
 */
(() => {
  'use strict';

  const shared = globalThis.__llgModShared;
  if (!shared || typeof shared.onTick !== 'function') {
    console.error('[llg-longline] 共享模块未加载（检查 src/mod 数字前缀与加载顺序）');
    return;
  }

  const NS = '__llgModLongline';
  if (globalThis[NS]) return;

  const HOST_ID = 'linglass-subtitle-overlay';
  const STYLE_ID = 'llg-longline-style';

  /**
   * `!important` 是必需的：官方样式表在 shadowRoot 里的加载顺序不可控，
   * 而我们要覆盖的正是它写死的 width / max-width（同优先级时先后顺序说了算）。
   */
  const CSS = `
.linglass-subtitle-overlay {
  width: 98% !important;
}
.linglass-subtitle-primary,
.linglass-subtitle-secondary {
  max-width: 96% !important;
  line-break: strict;
  text-wrap: balance;
}
`;

  function subtitleRoot() {
    const host = document.getElementById(HOST_ID);
    return host && host.shadowRoot ? host.shadowRoot : null;
  }

  /**
   * 已经确认注入过的那棵 shadowRoot。
   *
   * 心跳每秒跑一次，而 `querySelector` 是每秒一次的 DOM 查询 —— 记下 root 之后
   * 同一棵树上直接短路；只有官方换视频 / 重建播放器换了 root 时才重新查、重新注入。
   */
  let injectedRoot = null;

  function refresh() {
    const root = subtitleRoot();
    if (!root) {
      injectedRoot = null;
      return;
    }
    if (root === injectedRoot) return;
    if (root.querySelector('#' + STYLE_ID)) {
      injectedRoot = root;
      return;
    }

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = CSS;
    root.prepend(style);
    injectedRoot = root;
  }

  Object.defineProperty(globalThis, NS, {
    value: { refresh, CSS },
    configurable: true,
  });

  refresh();
  // 官方换视频 / 重建播放器时整棵浮层会被换掉，靠心跳兜底补注入
  shared.onTick(refresh);
})();
