/**
 * 开发期自动重载 —— Service Worker 侧（仅 --dev 构建注入）
 *
 * 由 build.mjs 挂到官方 service-worker-loader.js 上（MV3 只允许一个 SW，
 * 所以不能另起一个，只能搭在官方入口后面）。
 *
 * 机制：向本地 dev server 长轮询版本号，变了就 chrome.runtime.reload()。
 * 内容脚本的 __llg_dev_ping 是备用唤醒通道 —— SW 被回收后长轮询会断，
 * 靠它把 SW 叫醒再去问一次。
 */
(() => {
  'use strict';

  const BASE = 'http://127.0.0.1:8791';
  const RETRY_MS = 2000;
  const MAX_FAILURES = 30;

  let knownRev = null;
  let failures = 0;
  let running = false;

  function reload() {
    console.log('[llg-dev] 检测到新构建，重载扩展');
    chrome.runtime.reload();
  }

  /** 问一次当前版本号，变了就重载 */
  async function checkOnce() {
    const res = await fetch(`${BASE}/rev`, { cache: 'no-store' });
    const { rev } = await res.json();
    if (knownRev === null) {
      knownRev = rev;
      return;
    }
    if (rev !== knownRev) reload();
  }

  /** 长轮询：请求会被 dev server 挂住，直到有新的构建才返回 */
  async function loop() {
    if (running) return;
    running = true;
    failures = 0;

    while (running) {
      try {
        const res = await fetch(`${BASE}/wait?since=${knownRev ?? 0}`, { cache: 'no-store' });
        const { rev } = await res.json();
        failures = 0;

        if (knownRev === null) {
          knownRev = rev;
          continue;
        }
        if (rev !== knownRev) {
          reload();
          return;
        }
      } catch {
        failures += 1;
        if (failures >= MAX_FAILURES) {
          console.warn('[llg-dev] dev server 长时间无响应，暂停轮询（启动 make dev 后会自动恢复）');
          running = false;
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
      }
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg && msg.type === '__llg_dev_ping') {
      checkOnce().catch(() => {});
      if (!running) loop();
      sendResponse({ ok: true });
    }
    return false;
  });

  loop();
})();
