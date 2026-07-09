# CLAUDE.md

Repository guidance for agents working on Helix.

## Project Overview

Helix is an AI trading terminal with:

- `app/dashboard`: frontend trading dashboard
- `skills/helix-account`: exchange account reads
- `skills/helix-trading`: CEX execution
- `skills/helix-freqtrade`: Freqtrade strategy, backtest, deploy, and daemon control

## Boundaries

Skill code is only responsible for:

- Exchange account state
- Order execution and position protection
- Freqtrade lifecycle and daemon state

Do not add speculative abstractions or broad rewrites. Keep changes targeted to the requested module.

## Freqtrade

In CoinClaw containers, Freqtrade is a supervisord-managed daemon on `127.0.0.1:8080`. Do not start another Freqtrade process.

Use:

- `skills/helix-freqtrade/scripts/ft.mjs` for REST state and config actions
- `skills/helix-freqtrade/scripts/ft-deploy.mjs` for strategy creation, backtesting, deployment, and daemon restart
- `skills/helix-freqtrade/scripts/ft-dev.mjs` for debug endpoints and analyzed candles

When users ask about PnL, call `ft.mjs profit` and report both `profit_closed_coin` and `profit_all_coin`.

## Trading

Use `skills/helix-trading/scripts/exchange.mjs`.

Rules:

- Preview first, execute only after explicit confirmation.
- Use `close_position` for closing.
- Verify after close / stop operations.
- Never print secrets.

## Verification

```bash
node --check skills/helix-account/scripts/exchange.mjs
node --check skills/helix-trading/scripts/exchange.mjs
node --check skills/helix-trading/scripts/verify-order-matrix.mjs
node --check skills/helix-freqtrade/scripts/ft.mjs
node --check skills/helix-freqtrade/scripts/ft-deploy.mjs
```
