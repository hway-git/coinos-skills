---
name: helix-account
description: "Exchange account management for Helix. Use for balances, positions, open orders, closed orders, trade history, exchange API key setup guidance, registration links, and user account/trading history. Trigger words: balance, 余额, positions, 持仓, open orders, order history, 历史订单, API key, 配置, account, 账户, 注册, 开户, 我的交易, 最近操作."
metadata: { "openclaw": { "primaryEnv": "OKX_API_KEY", "requires": { "bins": ["node"] } } }
required_environment_variables:
  - name: OKX_API_KEY
    optional: true
    prompt: "OKX exchange API key"
    help: "Other exchanges use BINANCE_API_KEY / BYBIT_API_KEY / BITGET_API_KEY etc."
  - name: OKX_API_SECRET
    optional: true
    prompt: "OKX exchange API secret"
  - name: OKX_PASSWORD
    optional: true
    prompt: "OKX API passphrase"
  - name: BINANCE_API_KEY
    optional: true
    prompt: "Binance API key"
  - name: BINANCE_API_SECRET
    optional: true
    prompt: "Binance API secret"
---

# Helix Account

Read-only exchange account queries and API key setup guidance.

## Rules

- This skill is for account reads only: balances, positions, orders, trades, exchange list, and registration links.
- Do not execute transfers from this skill. If a request changes account state, route to `helix-trading` and require confirmation.
- Never print `.env`, API secrets, wallet private keys, or passphrases.
- If a key is missing, tell the user which exchange key is needed and where to configure it. Do not ask the user to paste secrets into chat unless there is no UI; if they do, use the safe `save_key` flow from `helix-trading`.

## Commands

Run from this skill directory:

```bash
node scripts/exchange.mjs balance '{"exchange":"okx"}'
node scripts/exchange.mjs positions '{"exchange":"okx","market_type":"swap"}'
node scripts/exchange.mjs open_orders '{"exchange":"okx","symbol":"BTC/USDT"}'
node scripts/exchange.mjs closed_orders '{"exchange":"okx","symbol":"BTC/USDT","limit":20}'
node scripts/exchange.mjs my_trades '{"exchange":"okx","symbol":"BTC/USDT","limit":20}'
node scripts/exchange.mjs exchanges
node scripts/register.mjs okx
```

## Supported Exchanges

`Binance`, `OKX`, `Bybit`, `Bitget`, `Gate.io`, `HTX`.

Symbol formats:

- Spot: `BTC/USDT`
- USDT perpetual: `BTC/USDT:USDT`
## Setup

Exchange API keys are loaded from the container EnvSection, `~/.helix/.env`, the current `.env`, or legacy OpenClaw env paths.

```bash
OKX_API_KEY=xxx
OKX_API_SECRET=xxx
OKX_PASSWORD=xxx

BINANCE_API_KEY=xxx
BINANCE_API_SECRET=xxx
```
