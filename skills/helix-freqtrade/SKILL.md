---
name: helix-freqtrade
description: "Freqtrade automation for Helix. Use for strategy creation, backtesting, hyperopt, deployment, switching strategy / pairs / dry-run / live mode, and querying daemon status, balance, open positions, and PnL. Trigger words: strategy, create strategy, backtest, hyperopt, deploy, switch live, open positions, PnL, 写策略, 回测, 部署策略, 切策略, 切实盘, 盈亏, 当前持仓."
metadata: { "openclaw": { "primaryEnv": "OKX_API_KEY", "requires": { "bins": ["node"] } } }
---

# Helix Freqtrade

Freqtrade strategy generation, backtesting, deployment, and daemon control.

## Core Rules

- In CoinClaw containers, Freqtrade is already managed by supervisord on `127.0.0.1:8888`. Do not start another process.
- In local Docker mode, use `docker/freqtrade/compose.yaml` through `ft-deploy.mjs`; do not install or start a second host daemon.
- Use `ft.mjs` and `ft-deploy.mjs`; do not manually edit daemon state without reloading or restarting through scripts.
- `create_strategy` is only for simple indicator prototypes. Production changes to `HelixIntradayStrategy` must follow `../../docs/PA_CORE_SPEC.md` and `../../docs/STRATEGY_DESIGN.md`.
- Deploy only through `ft-deploy.mjs deploy`. It requires backtest evidence for the exact current strategy code with at least one trade and positive total profit; editing the strategy invalidates older evidence.
- LIVE mode requires all of: current backtest evidence, `HELIX_LIVE_TRADING_ENABLED=true`, valid exchange credentials, `max_open_trades <= 2`, and a fresh Dashboard live authorization session. Never ask the user to paste the live token in chat.
- Do not use direct agent auto-entry. Strategy-driven entries must come from the Freqtrade daemon.
- Use `emergency_stop` for the safety path. It force-exits all open trades before stopping the daemon and does not require a live session.
- Answer PnL questions from `ft.mjs profit`, not from open trades alone.

## Helix Strategy Contract

- Brooks PA owns market context, setup, expectation, signal bar, and invalidation.
- EMA20 describes trend location and pullback context. MACD describes momentum phase. RSI uses the 55/45 control regime.
- EMA, MACD, RSI, and divergence may support or oppose an existing PA hypothesis; none may create an entry by itself.
- Current executable setups are H2/L2 second entries, breakout pullbacks, and failed breakouts at range edges.
- Evaluate closed candles only. Confirmed swings become available at their confirmation bar; never backdate them or infer intrabar event order from OHLC.
- Every strategy edit invalidates prior backtest evidence and must pass the strategy tests before a new backtest. Zero-trade or non-profitable evidence cannot be deployed.

## Dashboard Alignment

| User asks | Command |
|---|---|
| Total PnL / today made how much | `node scripts/ft.mjs profit` |
| Open positions | `node scripts/ft.mjs trades_open` |
| Balance | `node scripts/ft.mjs balance` |
| Current strategy / mode | `node scripts/ft.mjs daemon_info` |
| Closed trades | `node scripts/ft.mjs trades_history` |

When reporting PnL, include:

- `profit_closed_coin`: closed cumulative PnL
- `profit_all_coin`: closed + floating PnL

## Quick Reference

```bash
node scripts/ft.mjs daemon_info
node scripts/ft.mjs profit
node scripts/ft.mjs trades_open
node scripts/ft.mjs balance
node scripts/ft.mjs locks
node scripts/ft.mjs set_pairs '{"pairs":["BTC/USDT:USDT","ETH/USDT:USDT"]}'

node scripts/ft-deploy.mjs strategy_list
node scripts/ft-deploy.mjs create_strategy '{"name":"RSIStrategy","timeframe":"15m","indicators":["rsi","macd"],"direction":"long"}'
node scripts/ft-deploy.mjs backtest '{"strategy":"RSIStrategy","timeframe":"15m","timerange":"20250101-20260301"}'
node scripts/ft-deploy.mjs hyperopt '{"strategy":"RSIStrategy","timeframe":"1h","epochs":100}'
node scripts/ft-deploy.mjs deploy '{"strategy":"RSIStrategy","dry_run":true}'
node scripts/ft-deploy.mjs logs '{"lines":100}'
```

## Strategy Generation

Use `create_strategy` for simple technical-indicator strategies.

Supported indicators:

`rsi`, `bb`, `bollinger`, `ema`, `sma`, `macd`, `stochastic`, `kdj`, `atr`, `adx`, `cci`, `williams_r`, `willr`, `vwap`, `ichimoku`, `volume_sma`, `volume`, `obv`.

Direction:

- `long`: long only
- `short`: short only
- `both`: long and short

For custom logic, write a Python strategy file directly into the daemon strategy directory, backtest that exact code, then deploy it:

```bash
node scripts/ft-deploy.mjs backtest '{"strategy":"MyStrategy","timeframe":"15m"}'
node scripts/ft-deploy.mjs deploy '{"strategy":"MyStrategy"}'
```

## Config Changes

| Operation | Command | Restart |
|---|---|---|
| Switch strategy | `ft-deploy.mjs deploy {"strategy":"X","dry_run":true}` | yes |
| Switch pairs | `ft.mjs set_pairs {"pairs":[...]}` | reload only |
| Switch live | Dashboard live authorization + live deploy only | yes |
| Return to dry-run | `ft-deploy.mjs deploy {"strategy":"X","dry_run":true}` | yes |
| Reload config | `ft.mjs reload` | no |

## Manual Force Actions

Do not use `force_enter` for unattended live execution. Use `emergency_stop` for urgent liquidation and use the Dashboard reconciliation action to compare LIVE bot state with exchange positions and active orders.

The Freqtrade daemon's own strategy-driven entries/exits do not require per-trade confirmation after the user has intentionally deployed the strategy and mode.

## Pitfalls

- Do not answer PnL from `/status` only.
- Do not start `freqtrade trade` manually.
- Do not use random or synthetic data as real backtest input.
- Do not print `.env` or `.ft_api_pass`.
