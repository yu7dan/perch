"use strict";
/* 83-settings-search.js —— 设置搜索的纯函数。这里**不碰 DOM**，方便单独测。

   评分分层照 Orca 的 settings-search.ts（MIT）：
     节标题（pane 级）  exact 900 / prefix 850 / substring 800
     行标题             exact 700 / prefix 650 / substring 600
     描述               exact 500 / prefix 450 / substring 400
     关键词             exact 300 / prefix 250 / substring 200

   放在 84-settings.js 之前求值：84 只负责把 DOM 读成 {title,description,keywords}
   再调这里。查询为空 = 全部命中（返回 1，不是 0）；空查询不扫描条目。
   超长查询（> 2 KiB）直接判不命中 —— 粘贴一大段文本不该让页面逐字扫描。 */

const SETTINGS_SEARCH_MAX_BYTES = 2 * 1024;
const SETTINGS_SEARCH_NO_MATCH = 0;
const SETTINGS_SEARCH_EMPTY_SCORE = 1;

const SETTINGS_SEARCH_TIERS = {
  section: { exact: 900, prefix: 850, substring: 800 },
  title:   { exact: 700, prefix: 650, substring: 600 },
  desc:    { exact: 500, prefix: 450, substring: 400 },
  keyword: { exact: 300, prefix: 250, substring: 200 },
};

function settingsSearchNorm(query) {
  return String(query == null ? "" : query).trim().toLowerCase();
}

function settingsSearchTooLarge(query) {
  const s = String(query == null ? "" : query);
  if (typeof TextEncoder !== "undefined") {
    try { return new TextEncoder().encode(s).length > SETTINGS_SEARCH_MAX_BYTES; }
    catch (_) { /* 落到下面的粗略估计 */ }
  }
  return s.length * 3 > SETTINGS_SEARCH_MAX_BYTES;
}

function settingsSearchScoreText(nq, value, tier) {
  if (!nq || value == null) return SETTINGS_SEARCH_NO_MATCH;
  const v = String(value).toLowerCase();
  if (v === nq) return tier.exact;
  if (v.startsWith(nq)) return tier.prefix;
  if (v.includes(nq)) return tier.substring;
  return SETTINGS_SEARCH_NO_MATCH;
}

/* 一个条目 = { title, description, keywords: string[] }。
   isSection=true 时 title 用节标题那一档（900/850/800）。 */
function settingsSearchScoreEntry(query, entry, isSection) {
  if (settingsSearchTooLarge(query)) return SETTINGS_SEARCH_NO_MATCH;
  const nq = settingsSearchNorm(query);
  if (!nq) return SETTINGS_SEARCH_EMPTY_SCORE;
  const e = entry || {};
  const titleTier = isSection ? SETTINGS_SEARCH_TIERS.section : SETTINGS_SEARCH_TIERS.title;
  let best = settingsSearchScoreText(nq, e.title, titleTier);
  best = Math.max(best, settingsSearchScoreText(nq, e.description, SETTINGS_SEARCH_TIERS.desc));
  const kws = Array.isArray(e.keywords) ? e.keywords : [];
  for (const kw of kws) {
    best = Math.max(best, settingsSearchScoreText(nq, kw, SETTINGS_SEARCH_TIERS.keyword));
  }
  return best;
}

function settingsSearchMatch(query, entry, isSection) {
  return settingsSearchScoreEntry(query, entry, isSection) > SETTINGS_SEARCH_NO_MATCH;
}
