/**
 * 字幕句内断句（在 Linglass 的原文字幕行上画文节分隔符）
 *
 * 把原文行按日语「文节」切开，在每节之间显示一个分隔符（默认 |），
 * 适合跟读与朗读停顿：一眼看得出该在哪里换气。切分规则见 05-ja-segment.js。
 *
 * ── 为什么不往字幕里塞字符 ──
 * 官方原文行的结构是 [span.linglass-gap][span.linglass-word][gap][word]…，
 * 而它的点词查词、拖拽选词靠 .linglass-word 上的 data-start / data-end，
 * 对「整行的文本」做 slice（官方 buildPhraseText）。往这行里塞进任何可见字符，
 * 都会让这些字符偏移整体错位，用户选出来的词就不是他点的那几个了。
 * 所以这里一个字符都不加：分隔符是挂在空 span 上的 CSS ::after 伪元素 ——
 * 既不进 textContent，也不改文本长度。
 *
 * 顺带的好处：10-subtitle-track.js 读的就是 textContent，所以轨道记录的、
 * 导出的、桌面浮窗显示的，全部还是干净原文，不受本功能影响。
 *
 * ── 为什么不做 textContent 整体重写 ──
 * 那会连带把逐词 span 与 ruby 注音一起铲掉，官方的点词、悬停、拖拽选词全失效。
 * 同理，插入位置按「不计 rt 的字符偏移」计算，与官方 Tn() 的口径保持一致。
 *
 * ── 幂等 ──
 * 我们对字幕 shadowRoot 挂了 MutationObserver，而自己也会改它的子树。
 * 所以写入前必须先比对目标状态，完全一致就一个字节都不写，否则会把自己打成
 * 死循环（同样的教训见 50-settings-panel.js）。
 */
(() => {
  'use strict';

  const shared = globalThis.__llgModShared;
  const segment = globalThis.__llgModJaSegment;
  if (!shared || !segment) {
    console.error('[llg-jabreak] 共享模块未加载（检查 src/mod 数字前缀与加载顺序）');
    return;
  }

  const NS = '__llgModJaBreak';
  if (globalThis[NS]) return;

  const HOST_ID = 'linglass-subtitle-overlay';
  const GROUP_SEL = '.subtitle-group';
  const LINE_SEL = '.subtitle.subtitle-primary';

  const MARK_CLASS = 'llg-jabreak';
  const STYLE_ID = 'llg-jabreak-style';
  const STORE_KEY = 'llgJaBreak';

  // 兜底心跳（官方换了这一行的 DOM 之后，MutationObserver 未必每次都叫得动）
  // 不再自己 setInterval —— 见文件末尾 shared.onTick(refresh)，与其余四个模块共用
  // 同一个 1s 定时器（PLAN 025）。

  /** 分隔符。改这里就会同步进下面 CSS 的 ::after content */
  const SEPARATOR = '|';

  const TEXT_NODE = 3;
  const ELEMENT_NODE = 1;

  const MARK_CSS = `
.${MARK_CLASS} {
  pointer-events: none;
}
.${MARK_CLASS}::after {
  content: "${SEPARATOR}";
  margin: 0 .14em;
  opacity: .42;
  font-weight: 400;
}
`;

  let enabled = true;
  let boundRoot = null;
  let observer = null;
  /** 上一次算过的行与结果，避免每次都去跑分词器 */
  const cached = { line: null, text: null, points: [] };

  function warn(msg) {
    console.warn(`[llg-jabreak] ${msg}`);
  }

  function subtitleRoot() {
    const host = document.getElementById(HOST_ID);
    return host && host.shadowRoot ? host.shadowRoot : null;
  }

  // ---------------------------------------------------------------- 文本度量

  /**
   * 与官方 Tn() 对齐地取文本：ruby 注音（rt）不计入。
   * 官方正是拿这份文本去 slice，口径必须一致，否则插入位置会整体偏掉。
   */
  function textOf(el) {
    if (!el.querySelector('rt')) return el.textContent || '';
    const clone = el.cloneNode(true);
    for (const rt of clone.querySelectorAll('rt')) rt.remove();
    return clone.textContent || '';
  }

  /** 单个节点贡献的字符数（rt 为 0） */
  function nodeLength(node) {
    if (node.nodeType === TEXT_NODE) return node.data.length;
    if (node.nodeName === 'RT') return 0;
    if (!node.textContent) return 0;
    if (typeof node.querySelector !== 'function' || !node.querySelector('rt')) {
      return node.textContent.length;
    }
    return textOf(node).length;
  }

  /**
   * 在 node 的文本流（不计 rt）的第 offset 个字符处插入 marker。
   * 插入的 marker 自身没有文本，所以偏移在插入前后是一致的 —— 可以按原顺序逐个插。
   */
  function insertAt(node, offset, marker) {
    if (offset <= 0) {
      node.insertBefore(marker, node.firstChild);
      return;
    }

    let acc = 0;
    for (const child of [...node.childNodes]) {
      const length = nodeLength(child);

      // 正好落在这个节点前面（不切文本，也就不会留下空文本节点）
      if (offset <= acc) {
        node.insertBefore(marker, child);
        return;
      }

      if (offset > acc + length) {
        acc += length;
        continue;
      }

      if (child.nodeType === TEXT_NODE) {
        if (offset === acc + length) {
          node.insertBefore(marker, child.nextSibling);
        } else {
          // 落在文本节点内部：从这个字符处切开，marker 夹在中间
          node.insertBefore(marker, child.splitText(offset - acc));
        }
        return;
      }

      if (child.nodeType === ELEMENT_NODE) {
        if (offset === acc) {
          node.insertBefore(marker, child);
        } else {
          insertAt(child, offset - acc, marker);
        }
        return;
      }

      // 注释等其他节点不占字符，继续往下找
    }

    node.append(marker);
  }

  // ---------------------------------------------------------------- 注入

  function ensureStyle(root) {
    if (root.querySelector('#' + STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = MARK_CSS;
    root.prepend(style);
  }

  function markCount(line) {
    return line.querySelectorAll('.' + MARK_CLASS).length;
  }

  function clearMarks(line) {
    for (const el of line.querySelectorAll('.' + MARK_CLASS)) el.remove();
  }

  function makeMark(offset) {
    const mark = document.createElement('span');
    mark.className = MARK_CLASS;
    mark.dataset.offset = String(offset);
    mark.setAttribute('aria-hidden', 'true');
    return mark;
  }

  function applyLine(line) {
    if (!line) return;

    const text = textOf(line);

    // 文本没变、标记数也对 → 已经就位。这里必须早退：继续写会再触发一次
    // 自己的 observer（位置错了但数量恰好相同的极端情况由文本变化兜住）
    if (line === cached.line && text === cached.text
      && markCount(line) === cached.points.length) {
      return;
    }

    const points = segment.cut(text);
    cached.line = line;
    cached.text = text;
    cached.points = points;

    clearMarks(line);
    // 插入的 marker 自身不含文本，逐个按原偏移插入不会互相影响
    for (const offset of points) insertAt(line, offset, makeMark(offset));
  }

  /** 把当前这一句重新断一次。文本没变时是空操作。 */
  function refresh() {
    if (!enabled) return;

    const root = subtitleRoot();
    if (!root) return;

    bind(root);
    ensureStyle(root);

    const group = root.querySelector(GROUP_SEL);
    if (!group || group.style.display === 'none') return; // 空档期，字幕整体隐藏

    applyLine(root.querySelector(LINE_SEL));
  }

  function bind(root) {
    if (root === boundRoot && observer) return;
    observer?.disconnect();

    observer = new MutationObserver(() => {
      try {
        refresh();
      } catch (err) {
        warn(`断句失败：${err && err.message}`);
      }
    });
    // 只关心结构与文本；class 变化（逐词高亮）不影响我们的空 span
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    boundRoot = root;
  }

  function unbind() {
    observer?.disconnect();
    observer = null;
    boundRoot = null;

    const root = subtitleRoot();
    if (!root) return;
    for (const el of root.querySelectorAll('.' + MARK_CLASS)) el.remove();
  }

  // ---------------------------------------------------------------- 开关

  function setEnabled(next) {
    enabled = !!next;
    if (enabled) {
      refresh();
    } else {
      unbind();
    }
    chrome.storage.local.set({ [STORE_KEY]: { enabled } }).catch(() => {});
  }

  // 纯函数的测试钩子（切分逻辑本体在 05-ja-segment.js）
  Object.defineProperty(globalThis, NS, {
    value: { refresh, isEnabled: () => enabled, SEPARATOR },
    configurable: true,
  });

  // 登记到设置面板（线框图标，与 Linglass 面板内的 .toggle-icon 同一套语言）
  shared.registerFeature({
    id: 'jaBreak',
    title: '字幕句内断句',
    icon: `
<svg class="toggle-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M5 7v10"/>
  <path d="M19 7v10"/>
  <path d="M9.5 9.5h5"/>
  <path d="M9.5 14.5h5"/>
</svg>`,
    isOn: () => enabled,
    toggle: () => setEnabled(!enabled),
  });

  chrome.storage.local
    .get(STORE_KEY)
    .then((res) => {
      const saved = res && res[STORE_KEY];
      if (saved && typeof saved.enabled === 'boolean') enabled = saved.enabled;
      refresh();
    })
    .catch(() => {
      refresh();
    });

  // 官方换视频 / 重建播放器时，行的 DOM 会被整个换掉，靠心跳兜底重新注入。
  // 定时器挂在 00-shared.js 的共享心跳上（PLAN 025）：一个页面只需要一个 1s 定时器
  shared.onTick(refresh);
})();
