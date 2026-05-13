#!/usr/bin/env node
// AiCoin Drop Radar (OpenData) CLI
import { apiGet, cli } from '../lib/aicoin-api.mjs';

cli({
  // 2026-05-13 dogfood: sort_by="hot" 后端返 500, 其他 sort 模式都通。
  // catch 500 给替代方案, 别让 agent 把后端故障描述为参数错。
  list: async ({ page, page_size, status, activity_type, reward_type, min_total_raise, max_total_raise, created_at, keyword, board_keys, eco_keys, sort_by, sort_order, lan } = {}) => {
    const p = {};
    if (page) p.page = page;
    if (page_size) p.page_size = page_size;
    if (status) p.status = status;
    if (activity_type) p.activity_type = activity_type;
    if (reward_type) p.reward_type = reward_type;
    if (min_total_raise) p.min_total_raise = min_total_raise;
    if (max_total_raise) p.max_total_raise = max_total_raise;
    if (created_at) p.created_at = created_at;
    if (keyword) p.keyword = keyword;
    if (board_keys) p.board_keys = board_keys;
    if (eco_keys) p.eco_keys = eco_keys;
    if (sort_by) p.sort_by = sort_by;
    if (sort_order) p.sort_order = sort_order;
    if (lan) p.lan = lan;
    try {
      return await apiGet('/api/upgrade/v2/content/drop-radar/list', p);
    } catch (e) {
      if (sort_by === 'hot' && /^API 5\d\d/.test(e.message || '')) {
        return {
          success: false,
          errorCode: 500,
          error: e.message,
          实测结论: 'drop_radar.list({sort_by:"hot"}) 后端当前故障 (2026-05-13 dogfood), 其他 sort 模式都通。**不要重试**, 也不要当成参数错。',
          替代方案: '改用 sort_by 不传 (默认排序), 或换 sort_by="popularity" / "created_at" / "updated_at" / "total_raise" / "moni_score"。如需 hot 排序长期可用, 请联系 AiCoin 客服 service@aicoin.com 报修。',
        };
      }
      throw e;
    }
  },
  detail: async ({ airdrop_id, lan } = {}) => {
    if (!airdrop_id) return { error: 'airdrop_id is required. Use "list" action first to find valid IDs.' };
    const p = { airdrop_id };
    if (lan) p.lan = lan;
    const [detail, team, xFollowing] = await Promise.all([
      apiGet('/api/upgrade/v2/content/drop-radar/detail', p).catch(e => ({ error: e.message })),
      apiGet('/api/upgrade/v2/content/drop-radar/team', { airdrop_id }).catch(e => ({ error: e.message })),
      apiGet('/api/upgrade/v2/content/drop-radar/x-following', { airdrop_id }).catch(e => ({ error: e.message })),
    ]);
    if (detail.error) {
      // 实测: 当前 key 档位不够时上游会返 HTTP 403 (而不是 304 业务错误)。
      // 不要把这类失败统一归因为 "airdrop_id 无效", 否则 agent 会让用户改参数。
      const isPaywall = /API 403|forbidden|paid|付费/i.test(detail.error);
      if (isPaywall) {
        return {
          success: false,
          errorCode: 403,
          error: detail.error,
          实测结论: 'drop_radar.detail 端点需要更高档 AiCoin 套餐。当前 key 拿不到该数据。请告知用户"项目详情需要 AiCoin 标准版以上, 当前账号档位不够; 可改用 list (项目列表已含基础信息)"。**不要让用户改 airdrop_id**, 这不是参数问题。',
        };
      }
      return { error: `Project not found or invalid airdrop_id "${airdrop_id}". Use "list" to browse available projects.`, detail: detail.error };
    }
    return { ...detail, team: team.data || team, x_following: xFollowing.data || xFollowing };
  },
  widgets: ({ lan } = {}) => {
    const p = {};
    if (lan) p.lan = lan;
    return apiGet('/api/upgrade/v2/content/drop-radar/widgets', p);
  },
  filters: ({ lan } = {}) => {
    const p = {};
    if (lan) p.lan = lan;
    return apiGet('/api/upgrade/v2/content/drop-radar/filters', p);
  },
  events: ({ airdrop_id } = {}) => {
    return apiGet('/api/upgrade/v2/content/drop-radar/events', { airdrop_id });
  },
  team: ({ airdrop_id } = {}) => {
    return apiGet('/api/upgrade/v2/content/drop-radar/team', { airdrop_id });
  },
  x_following: ({ airdrop_id } = {}) => {
    return apiGet('/api/upgrade/v2/content/drop-radar/x-following', { airdrop_id });
  },
  status_changes: ({ days, page, page_size, lan } = {}) => {
    const p = {};
    if (days) p.days = days;
    if (page) p.page = page;
    if (page_size) p.page_size = page_size;
    if (lan) p.lan = lan;
    return apiGet('/api/upgrade/v2/content/drop-radar/status-changes', p);
  },
  tweets: ({ keywords, page_size, last_id, lan } = {}) => {
    // 实测: 不传 keywords 上游会 502 (而不是 400),让 agent 误判为接口故障。
    // 默认填 "airdrop" 拿一份通用推文列表,agent 后续可自定义。
    const p = { keywords: keywords || 'airdrop' };
    if (page_size) p.page_size = page_size;
    if (last_id) p.last_id = last_id;
    if (lan) p.lan = lan;
    return apiGet('/api/upgrade/v2/content/drop-radar/tweets', p);
  },
});
