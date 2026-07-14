#!/usr/bin/env node
// Automated Trading — config management + trade execution helper
// Strategy decisions are made by the AI agent, not this script.
import { cli } from '../lib/cli.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dir = dirname(fileURLToPath(import.meta.url));
const WORKSPACE = resolve(process.env.HOME || '', '.openclaw', 'workspace');
const CONFIG_PATH = resolve(WORKSPACE, 'helix-trade-config.json');

const DEFAULT_CONFIG = {
  exchange: 'okx',
  symbol: 'BTC/USDT:USDT',
  market_type: 'swap',
  capital_pct: 0.5,
  leverage: 20,
  stop_loss_pct: 0.025,
  take_profit_pct: 0.05,
};

function loadConfig() {
  if (existsSync(CONFIG_PATH)) {
    try { return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) }; } catch {}
  }
  return { ...DEFAULT_CONFIG };
}

function saveConfig(cfg) {
  writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

function ex(action, params) {
  const args = [resolve(__dir, 'exchange.mjs'), action, JSON.stringify(params)];
  try {
    return JSON.parse(execFileSync(process.execPath, args, { encoding: 'utf-8', cwd: resolve(__dir, '..'), timeout: 30000, env: { ...process.env, HELIX_INTERNAL_CALL: '1' } }));
  } catch (e) {
    return { error: `exchange.mjs ${action} failed: ${e.message}` };
  }
}

cli({
  // Save trading config
  setup: async (params) => {
    const cfg = { ...loadConfig(), ...params };
    saveConfig(cfg);
    return { saved: CONFIG_PATH, config: cfg };
  },

  // Show config + balance + positions
  status: async (params) => {
    const cfg = { ...loadConfig(), ...params };
    let balance, positions, openOrders;
    try { balance = ex('balance', { exchange: cfg.exchange, market_type: cfg.market_type }); } catch (e) { balance = { error: e.message }; }
    try { positions = ex('positions', { exchange: cfg.exchange, market_type: cfg.market_type }); } catch (e) { positions = { error: e.message }; }
    try { openOrders = ex('open_orders', { exchange: cfg.exchange, symbol: cfg.symbol, market_type: cfg.market_type }); } catch (e) { openOrders = { error: e.message }; }
    return { config: cfg, balance, positions, open_orders: openOrders };
  },

  // Execute a trade with risk management (agent decides direction)
  open: async () => {
    throw new Error('Direct agent auto-trade is disabled. Use a backtested Freqtrade strategy with the Dashboard live authorization gate.');
  },

  // Close current position
  close: async () => {
    throw new Error('Direct agent auto-trade is disabled. Use exchange.mjs close_position with preview/confirmation, or Freqtrade emergency_stop.');
  },
});
