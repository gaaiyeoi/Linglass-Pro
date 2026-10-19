/**
 * SRT 解析与「译文贴回」计划（纯函数）
 *
 * 只回答三件事，一个 DOM 都不碰，所以能被 Node 侧的测试直接驱动：
 *
 *   1. parseSrt(text)              一段 SRT 文本 → [{ start, end, text }]
 *   2. planImport(cues, parsed)    导入句 → 该贴到轨道哪一句（**只出计划，不写轨道**）
 *   3. fingerprint(cues)           原文轨的廉价指纹（句数 + 首句 + 末句）
 *
 * 定位：PLAN 031 的「离线翻译工作流」——
 * 用户把单语原文导出去、在扩展之外翻好、再把译文 SRT 导回来，浮窗里就有双语了。
 * 翻译这件事在扩展之外完成，本模块只负责文件两端的那点事。
 *
 * ── 为什么判据是时间戳而不是文本 ──
 * 「导出 → 翻译 → 导入」这条链上，时间戳不会被翻译工具动过，而文本**一定**被改过
 * （改了才是译文）。拿文本去匹配等于拿「改过的东西」当钥匙，所以文本只做兜底，
 * 主判据是 start 落在 [cue.start - tol, cue.end + tol] 这个窗口里。
 *
 * ── 一条硬约定：导入句的文本**整块**当作译文 ──
 * 翻译工具的输出格式千奇百怪（有的双语导出、有的只留译文、有的把原样续行），
 * 与其猜「哪一行才是译文」，不如定死一条让用户保证输出。一句里有多个文本行时，
 * 用空格拼成一行 —— 浮窗与面板都是单行渲染，多行会撑坏排版。
 *
 * 挂在 globalThis.__llgModSrt 上（与 05-ja-segment.js 同款做法）。
 */
(() => {
  'use strict';

  const NS = '__llgModSrt';
  if (globalThis[NS]) return;

  /**
   * 时间戳容差（秒）。
   *
   * 导出用的是同源时间戳，正常情况下应当几乎零偏差；留这 1.5s 是给「手改过」
   * 「翻译工具重排过时间轴」「毫秒被四舍五入」留余量。
   */
  const DEFAULT_TOLERANCE = 1.5;

  /** 轨道句没有 end 时（还没定稿）给一个默认窗口，与 10-subtitle-track.js 同值 */
  const FALLBACK_CUE_SECONDS = 6;

  /** `00:01:02,345 --> 00:01:05,000`，毫秒分隔符两种都收（`,` 与 `.`） */
  const TIME_LINE_RE = /^(\d{1,3}):([0-5]?\d):([0-5]?\d)[.,](\d{1,3})\s*-->\s*(\d{1,3}):([0-5]?\d):([0-5]?\d)[.,](\d{1,3})/;

  /** `12:34:56,789` 的四个部分 → 秒（小数） */
  function stampToSeconds(hours, minutes, seconds, fraction) {
    const ms = Number(String(fraction).padEnd(3, '0').slice(0, 3));
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds) + ms / 1000;
  }

  /**
   * 解析 SRT 文本。
   *
   * 边界（都是真实文件里见过的）：UTF-8 BOM、CRLF、`,` 与 `.` 两种毫秒分隔、
   * 一句多行、时间戳乱序、末块没有尾换行、以及各种坏块。坏块**跳过不抛** ——
   * 用户手上的文件是从各种工具里倒出来的，一块坏掉不该让整次导入失败。
   *
   * @param {string} text
   * @returns {Array<{start: number, end: number, text: string}>} 按 start 升序
   */
  function parseSrtBlocks(text) {
    if (typeof text !== 'string' || !text) return [];

    const clean = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const out = [];

    for (const block of clean.split(/\n{2,}/)) {
      const lines = block.split('\n').filter((line) => line.trim() !== '');
      if (!lines.length) continue;

      // 序号行可有可无（有的工具导出时省掉它）
      let cursor = /^\d+$/.test(lines[0].trim()) ? 1 : 0;
      const match = TIME_LINE_RE.exec(String(lines[cursor] || '').trim());
      if (!match) continue;
      cursor += 1;

      const start = stampToSeconds(match[1], match[2], match[3], match[4]);
      const end = stampToSeconds(match[5], match[6], match[7], match[8]);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

      // 整块文本当译文；多行拼成一行（浮窗与面板都是单行渲染）
      const bodyLines = lines.slice(cursor).map((line) => line.trim()).filter(Boolean);
      const body = bodyLines.join(' ').trim();
      if (!body) continue;

      // `lines` 给「整条轨道导入」用：第一行原文、其余行译文（PLAN 052）
      out.push({ start, end, text: body, lines: bodyLines });
    }

    out.sort((a, b) => a.start - b.start);
    return out;
  }

  /**
   * 只吃文本的投影（PLAN 031 起的公开结构：start / end / text）。
   *
   * 保持它是投影而不是另写一套解析：`parseSrt` 的输出被导入、测试和面板共用，
   * 多出来的 `lines` 字段会破坏 strict deepEqual 的既有断言。
   */
  function parseSrt(text) {
    return parseSrtBlocks(text).map(({ start, end, text: body }) => ({ start, end, text: body }));
  }

  /** 轨道句在时间轴上的结束点（没定稿就按默认时长兜一个） */
  function cueEnd(cue) {
    const end = Number(cue && cue.end);
    if (Number.isFinite(end) && end > 0) return end;
    return Number(cue && cue.start) + FALLBACK_CUE_SECONDS;
  }

  /**
   * 排「导入句 → 轨道句」的贴回计划。**纯函数，不碰轨道。**
   *
   * 判据（按优先级）：
   *   1. 候选 = start 落在 `[cue.start - tolerance, cue.end + tolerance]` 里的轨道句；
   *   2. 候选里取与导入句**重叠最大**的那一个（重叠为负也比没候选强，但仍受限窗口约束）；
   *   3. 一个轨道句只贴一次（贴过就 consumed），避免两句译文落到同一句上。
   *
   * @param {Array} trackCues 轨道句（带 start / end）
   * @param {Array} parsed    parseSrt 的结果
   * @param {{tolerance?: number}} [options]
   * @returns {{assignments: Array<{start: number, secondary: string}>,
   *            missed: Array<{start: number, end: number, text: string}>, total: number}}
   */
  function planImport(trackCues, parsed, options = {}) {
    const cues = Array.isArray(trackCues) ? trackCues : [];
    const list = Array.isArray(parsed) ? parsed : [];
    const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : DEFAULT_TOLERANCE;

    const consumed = new Set();
    const assignments = [];
    const missed = [];

    for (const item of list) {
      const start = Number(item && item.start);
      if (!Number.isFinite(start) || !item.text) {
        missed.push(item);
        continue;
      }
      const end = Number.isFinite(Number(item.end)) ? Number(item.end) : start;

      let best = -1;
      let bestOverlap = -Infinity;
      for (let i = 0; i < cues.length; i += 1) {
        if (consumed.has(i)) continue;
        const cue = cues[i];
        const cueStart = Number(cue && cue.start);
        if (!Number.isFinite(cueStart)) continue;
        const cueStop = cueEnd(cue);
        if (start < cueStart - tolerance || start > cueStop + tolerance) continue;

        const overlap = Math.min(cueStop, end) - Math.max(cueStart, start);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          best = i;
        }
      }

      if (best < 0) {
        missed.push(item);
        continue;
      }
      consumed.add(best);
      assignments.push({ start: Number(cues[best].start), secondary: item.text });
    }

    return { assignments, missed, total: list.length };
  }

  /**
   * 原文轨指纹：句数 + 首句 + 末句。
   *
   * 用途只是「视频是不是换了 / 官方是不是重新断句了」的**廉价**保险 ——
   * 用户口径是「默认没变，不对再重新生成」，所以这里不做自动重翻、不做校验和，
   * 只求便宜（导出与导入各算一次，几毫秒）。
   */
  function fingerprint(cues) {
    const list = (Array.isArray(cues) ? cues : []).filter((cue) => cue && cue.primary);
    if (!list.length) return { count: 0, first: '', last: '' };
    return {
      count: list.length,
      first: String(list[0].primary),
      last: String(list[list.length - 1].primary),
    };
  }

  /** 两个指纹是不是同一份（结构相同即可，null 一律算不同） */
  function sameFingerprint(a, b) {
    if (!a || !b) return false;
    return a.count === b.count && a.first === b.first && a.last === b.last;
  }

  Object.defineProperty(globalThis, NS, {
    value: {
      parseSrt,
      parseSrtBlocks,
      planImport,
      fingerprint,
      sameFingerprint,
      DEFAULT_TOLERANCE,
    },
    configurable: true,
  });
})();
