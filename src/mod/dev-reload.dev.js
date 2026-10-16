/**
 * 开发期自动重载 —— 内容脚本侧（仅 --dev 构建注入）
 *
 * 只负责周期性唤醒 service worker，让它去 dev server 查有没有新构建。
 * 真正的 chrome.runtime.reload() 在 dev-reload-sw.dev.js 里（内容脚本没有该 API）。
 */
(() => {
  'use strict';

  const PING_MS = 10000;

  function ping() {
    try {
      chrome.runtime.sendMessage({ type: '__llg_dev_ping' }, () => {
        void chrome.runtime.lastError;
      });
    } catch {
      // 扩展正在重载，这个窗口的连接会短暂失效，忽略
    }
  }

  ping();
  setInterval(ping, PING_MS);
})();
