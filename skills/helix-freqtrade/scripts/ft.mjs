#!/usr/bin/env node
// Freqtrade Bot Control CLI.
//
// 在 CoinClaw 三引擎容器里, freqtrade 是 supervisord 管的常驻 daemon —
// 不要自己起进程, 用本脚本通过 :8888 REST 控制. 策略和模式变更统一走
// ft-deploy.mjs deploy, 由它执行回测指纹门禁并重启 daemon.
import {
  readFileSync, writeFileSync, copyFileSync, renameSync, chmodSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ftGet, ftPost, ftDelete, ftCli } from '../lib/freqtrade-api.mjs';
import { hostModeFreqtradePaths, managedFreqtradeEnv } from '../lib/coinclaw-env.mjs';
import {
  emergencyStopIsLatched,
  requireHealthyDeploymentTransaction,
  requireNoEmergencyStop,
  setEmergencyStopLatch,
  withDeploymentLock,
  withEntryTransitionLock,
} from '../lib/deployment-transaction.mjs';

function controlUserData() {
  return managedFreqtradeEnv()?.freqtradeUserdir || hostModeFreqtradePaths().userdir;
}

function withControlLock(operation, callback) {
  return withDeploymentLock(controlUserData(), operation, callback);
}

function withEntryOpeningLock(operation, callback) {
  const userData = controlUserData();
  return withEntryTransitionLock(userData, operation, async () => {
    requireHealthyDeploymentTransaction(userData);
    const config = readConfig();
    if (config.strategy === 'HelixSignalStrategy') {
      throw new Error(`${operation} for HelixSignalStrategy must go through the verified ft-deploy lifecycle`);
    }
    requireNoEmergencyStop(userData);
    try {
      const result = await callback();
      requireNoEmergencyStop(userData);
      return result;
    } catch (error) {
      if (emergencyStopIsLatched(userData)) {
        try {
          await requestEntryState(false);
        } catch (compensationError) {
          throw new Error(`${error.message}; entry compensation failed: ${compensationError.message}`, { cause: error });
        }
      }
      throw error;
    }
  });
}

// ── 帮助函数: 读 / 改 daemon 的 config.json ───────────────────────────
// 三引擎下 config 路径不同, 通过 coinclaw-env 解析.
function configPath() {
  const env = managedFreqtradeEnv();
  return env?.configPath || hostModeFreqtradePaths().configPath;
}

function readConfig() {
  return JSON.parse(readFileSync(configPath(), 'utf-8'));
}

function writeConfigAtomic(cfg) {
  const path = configPath();
  // 简单备份 — 改坏了 daemon autorestart 会一直 FATAL, 留一个 .bak 让 user 能 rollback.
  // .bak 含明文交易所 key/secret, 必须 0600 收紧权限, 别让同机其它进程读到.
  const bak = `${path}.bak`;
  copyFileSync(path, bak);
  chmodSync(bak, 0o600);
  // 简单 atomic: 写到 tmp 再原地 rename (同目录 POSIX 原子, 不跨 fs 无 EXDEV).
  // tmp 同样含明文 key/secret, 先 0600 再 rename.
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(cfg, null, 4) + '\n');
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  // rename 保留 tmp 的 mode, 但最终 config 显式再收紧一次以防万一.
  chmodSync(path, 0o600);
}

function stopForwardRuntimeAfterEmergency(config) {
  if (!config?.helix_signal_forward_deployment_path) return;
  const deployScript = resolve(dirname(fileURLToPath(import.meta.url)), 'ft-deploy.mjs');
  const output = execFileSync(process.execPath, [deployScript, 'stop'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    env: process.env,
  });
  let result;
  try { result = JSON.parse(output); } catch { throw new Error('ft-deploy stop returned an invalid result'); }
  if (result?.stopped !== true) {
    throw new Error(result?.error || result?.reason || 'ft-deploy did not confirm forward runtime stop');
  }
}

function entriesAreRunning(config) {
  const state = String(config?.state || '').toLowerCase();
  if (!state) throw new Error('Freqtrade show_config did not report an entry state');
  return state !== 'stopped' && state !== 'stop';
}

async function waitForEntryState(expectedRunning) {
  const timeoutMs = Number(process.env.HELIX_TEST_ENTRY_TIMEOUT_MS) || 5_000;
  const deadline = Date.now() + timeoutMs;
  let lastError = 'entry state was not available';
  while (Date.now() < deadline) {
    try {
      const config = await ftGet('show_config', {}, { timeoutMs: 2_000 });
      if (entriesAreRunning(config) === expectedRunning) return config;
      lastError = `entry state remained ${String(config?.state || 'unknown')}`;
    } catch (error) {
      lastError = error.message;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`entry state confirmation failed: ${lastError}`);
}

async function requestEntryState(expectedRunning) {
  let requestError = null;
  try {
    await ftPost(expectedRunning ? 'start' : 'stopentry', {}, { timeoutMs: 5_000 });
  } catch (error) {
    requestError = error;
  }
  try {
    return await waitForEntryState(expectedRunning);
  } catch (confirmationError) {
    const prefix = requestError ? `${requestError.message}; ` : '';
    throw new Error(`${prefix}${confirmationError.message}`);
  }
}

ftCli({
  // ── 健康检查 / 信息查询 (REST GET) ──────────────────────────
  ping: () => ftGet('ping'),
  version: () => ftGet('version'),
  sysinfo: () => ftGet('sysinfo'),
  health: () => ftGet('health'),
  config: () => ftGet('show_config'),

  // ── daemon 综合信息 (一次拿状态 / 策略 / 模式 / 交易对) ───
  // 给 agent 在用户问 "freqtrade 现在跑什么?" 时单次调用就能答全.
  daemon_info: async () => {
    const cfg = await ftGet('show_config');
    let configuredPairs = [];
    let storedConfig = {};
    try {
      storedConfig = readConfig();
      configuredPairs = storedConfig.exchange?.pair_whitelist || [];
    } catch {}
    const [status, version] = await Promise.all([
      ftGet('status').catch(() => []),
      ftGet('version').catch(() => ({})),
    ]);
    return {
      online: true,
      version: version.version,
      strategy: cfg.strategy,
      timeframe: cfg.timeframe,
      exchange: cfg.exchange,
      trading_mode: cfg.trading_mode,
      dry_run: cfg.dry_run,
      max_open_trades: cfg.max_open_trades,
      stake_currency: cfg.stake_currency,
      stake_amount: cfg.stake_amount,
      pair_whitelist: Array.isArray(cfg.whitelist) && cfg.whitelist.length > 0
        ? cfg.whitelist
        : Array.isArray(cfg.pair_whitelist) && cfg.pair_whitelist.length > 0
          ? cfg.pair_whitelist
          : configuredPairs,
      signal_artifact_hash: typeof cfg.helix_signal_artifact_hash === 'string'
        ? cfg.helix_signal_artifact_hash
        : typeof storedConfig.helix_signal_artifact_hash === 'string'
          ? storedConfig.helix_signal_artifact_hash
          : null,
      bot_name: cfg.bot_name,
      open_trades_count: Array.isArray(status) ? status.length : 0,
    };
  },

  // ── daemon 状态控制 ────────────────────────────────────────
  start: () => withControlLock('start', () => withEntryOpeningLock('start entries', () => ftPost('start'))),
  stop: () => withControlLock('stop', () => ftPost('stop')),
  stop_entry: () => withControlLock('stop_entry', () => ftPost('stopentry')),
  reload: () => withControlLock('reload', () => (
    withEntryOpeningLock('reload config', () => ftPost('reload_config'))
  )),

  emergency_stop: async () => {
    const env = managedFreqtradeEnv();
    const userData = env?.freqtradeUserdir || hostModeFreqtradePaths().userdir;
    setEmergencyStopLatch(userData);
    const result = await withEntryTransitionLock(userData, 'emergency stop', async () => {
      const deadline = Date.now() + (Number(process.env.HELIX_TEST_EMERGENCY_TIMEOUT_MS) || 50_000);
      await requestEntryState(false);
      const openTrades = await ftGet('status', {}, { timeoutMs: 5_000 });
      if (!Array.isArray(openTrades)) throw new Error('Freqtrade status did not return open trades');
      let forceExit = { result: 'No open trades.' };
      let forceExitError = null;
      let remainingTrades = openTrades;
      if (openTrades.length > 0) {
        try {
          forceExit = await ftPost('forceexit', { tradeid: 'all', ordertype: 'market' }, { timeoutMs: 5_000 });
          const exitDeadline = deadline - 10_000;
          while (Date.now() < exitDeadline) {
            remainingTrades = await ftGet('status', {}, { timeoutMs: 3_000 });
            if (Array.isArray(remainingTrades) && remainingTrades.length === 0) break;
            await new Promise((resolveWait) => setTimeout(resolveWait, 1_000));
          }
          if (!Array.isArray(remainingTrades) || remainingTrades.length > 0) {
            forceExitError = `Emergency exit did not reach flat state; ${Array.isArray(remainingTrades) ? remainingTrades.length : 'unknown'} trade(s) remain.`;
          }
        } catch (error) {
          forceExitError = error.message;
        }
      }

      if (!forceExitError) {
        try {
          remainingTrades = await ftGet('status', {}, { timeoutMs: 5_000 });
          if (!Array.isArray(remainingTrades)) throw new Error('Freqtrade status did not return open trades');
          if (remainingTrades.length > 0) {
            forceExitError = `Emergency exit did not reach final flat state; ${remainingTrades.length} trade(s) remain.`;
          }
        } catch (error) {
          forceExitError = error.message;
        }
      }

      let stopped = null;
      let stopError = null;
      if (!forceExitError) {
        try {
          stopped = await ftPost('stop', {}, { timeoutMs: Math.max(1_000, deadline - Date.now()) });
          let stopConfirmed = false;
          let lastState = 'unknown';
          while (Date.now() < deadline) {
            const effective = await ftGet('show_config', {}, { timeoutMs: 2_000 });
            lastState = String(effective?.state || 'unknown').toLowerCase();
            if (lastState === 'stopped' || lastState === 'stop') {
              stopConfirmed = true;
              break;
            }
            await new Promise((resolveWait) => setTimeout(resolveWait, 250));
          }
          if (!stopConfirmed) stopError = `Daemon stop was not confirmed; state remained ${lastState}.`;
        } catch (error) {
          stopError = error.message;
        }
      } else {
        stopError = 'Daemon left running because flat state was not confirmed.';
      }

      return {
        success: !forceExitError && !stopError,
        open_trades_before: openTrades.length,
        open_trades_after: Array.isArray(remainingTrades) ? remainingTrades.length : null,
        force_exit: forceExit,
        force_exit_error: forceExitError,
        stopped,
        stop_error: stopError,
      };
    });
    if (!result.success) return result;
    let stoppedConfig = null;
    try {
      await withDeploymentLock(userData, 'persist emergency stop state', async () => {
        const config = readConfig();
        config.initial_state = 'stopped';
        writeConfigAtomic(config);
        stoppedConfig = config;
      }, 15_000);
    } catch (error) {
      result.success = false;
      result.stop_error = `Daemon stopped, but initial_state could not be persisted: ${error.message}`;
      return result;
    }
    try {
      stopForwardRuntimeAfterEmergency(stoppedConfig);
    } catch (error) {
      result.success = false;
      result.stop_error = `Daemon stopped, but forward runtime could not be stopped: ${error.message}`;
    }
    return result;
  },

  // ── 配置变更 (改 config.json + reload) ────────────────────
  // 切交易对白名单. pair_whitelist 改了之后调 /reload_config 即可,
  // 不需要重启 daemon. freqtrade 会在下一根 candle close 时应用.
  set_pairs: async ({ pairs, reload = true }) => {
    if (!Array.isArray(pairs) || pairs.length === 0) {
      throw new Error('pairs 必填且非空, 例: {"pairs":["BTC/USDT:USDT","ETH/USDT:USDT"]}');
    }
    const env = managedFreqtradeEnv();
    if (!env) throw new Error('set_pairs requires a managed Freqtrade runtime');
    return withDeploymentLock(env.freqtradeUserdir, 'set_pairs', async () => {
      requireHealthyDeploymentTransaction(env.freqtradeUserdir);
      const cfg = readConfig();
      if (cfg.helix_signal_artifact_hash) {
        throw new Error('Signal Artifact pairs are immutable; deploy a different artifact instead of set_pairs.');
      }
      const before = cfg.exchange?.pair_whitelist;
      const apply = async () => {
        if (!cfg.exchange) cfg.exchange = {};
        cfg.exchange.pair_whitelist = pairs;
        writeConfigAtomic(cfg);
        const reloaded = reload ? await ftPost('reload_config') : null;
        return { from: before, to: pairs, reloaded };
      };
      return reload ? withEntryOpeningLock('reload pair config', apply) : apply();
    });
  },

  // ── 状态 / 持仓 / 交易历史 (REST GET) ───────────────────────
  balance: () => ftGet('balance'),
  // /status 返回 open trades 数组, 命名 trades_open 比 status 直观 — agent
  // 看到 "trades_open" 不会误以为是 daemon 状态.
  trades_open: () => ftGet('status'),
  trades_count: () => ftGet('count'),
  trade_by_id: ({ trade_id }) => ftGet(`trade/${trade_id}`),
  trades_history: ({ limit, offset } = {}) => ftGet('trades', { limit, offset }),
  locks: () => ftGet('locks'),
  // 仓位 force-enter / force-exit, 注意 freqtrade REST 这两个端点是
  // 'forcebuy' / 'forcesell' (历史名) 不是 force_enter/force_exit.
  force_enter: (p) => withControlLock('force_enter', () => withEntryOpeningLock('force enter', () => ftPost('forcebuy', p))),
  force_exit: (p) => withControlLock('force_exit', () => ftPost('forcesell', p)),
  cancel_order: ({ trade_id }) => withControlLock('cancel_order', () => ftDelete(`trades/${trade_id}/open-order`)),
  delete_trade: ({ trade_id }) => withControlLock('delete_trade', () => ftDelete(`trades/${trade_id}`)),

  // ── 盈亏 / 绩效 ────────────────────────────────────────────
  // /profit 是回答 "现在赚多少 / 盈亏多少" 类问题的权威接口:
  //   - profit_closed_coin: 已平仓累计盈亏 (USDT) — dashboard 顶栏的累计盈亏 = 这个
  //   - profit_all_coin:    已平仓 + 浮动 (含未平仓) 总盈亏 (USDT)
  //   - 浮动盈亏 = profit_all_coin - profit_closed_coin
  //   - closed_trade_count: 已平仓交易数
  // 反例: 只调 /status 拿 open trades 浮动盈亏会漏掉已平仓部分,
  // 跟 dashboard 数字不一致.
  profit: () => ftGet('profit'),
  profit_per_pair: () => ftGet('performance'),
  daily: ({ count } = {}) => ftGet('daily', { timescale: count }),
  weekly: ({ count } = {}) => ftGet('weekly', { timescale: count }),
  monthly: ({ count } = {}) => ftGet('monthly', { timescale: count }),
  stats: () => ftGet('stats'),

  // ── 日志 (受 freqtrade api 自带 limit 限制) ────────────────
  logs: ({ limit } = {}) => ftGet('logs', { limit }),
});
