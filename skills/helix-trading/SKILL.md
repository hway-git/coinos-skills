---
name: helix-trading
description: "CEX exchange trading for Helix. Use for spot/perpetual orders, closing positions, stop loss, take profit, leverage, margin mode, cancel orders, and exchange key saving. All orders must go through node scripts/exchange.mjs with preview + explicit confirmation. Trigger words: buy, sell, long, short, leverage, close position, stop loss, take profit, 买, 卖, 下单, 做多, 做空, 开仓, 平仓, 止盈, 止损, 杠杆."
metadata: { "openclaw": { "primaryEnv": "OKX_API_KEY", "requires": { "bins": ["node"] } } }
required_environment_variables:
  - name: OKX_API_KEY
    optional: true
    prompt: "OKX exchange API key"
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

# Helix Trading

CEX spot and perpetual execution through `scripts/exchange.mjs`.

## Hard Rules

1. Do not write custom order code. No ad-hoc `ccxt`, `fetch`, or exchange SDK snippets for live orders.
2. `create_order`, `close_position`, and `set_stop` are two-step flows. First call returns a preview. Execute only after the user explicitly confirms.
3. Do not auto-adjust user amount, side, leverage, margin mode, symbol, or market type.
4. Close positions with `close_position`, not a reverse `create_order`.
5. Leverage and margin-mode changes require a risk explanation and explicit confirmation.
6. After closing or setting stops, verify with `positions` or `stop_orders` and summarize the actual result.

## Order Flow

Preview:

```bash
node scripts/exchange.mjs create_order '{"exchange":"okx","symbol":"BTC/USDT:USDT","type":"market","side":"buy","amount":0.01,"market_type":"swap"}'
```

Execute after confirmation:

```bash
node scripts/exchange.mjs create_order '{"exchange":"okx","symbol":"BTC/USDT:USDT","type":"market","side":"buy","amount":0.01,"market_type":"swap","confirmed":"true"}'
```

## Close Position

Preview:

```bash
node scripts/exchange.mjs close_position '{"exchange":"okx","symbol":"BTC/USDT:USDT","market_type":"swap"}'
```

Execute after confirmation:

```bash
node scripts/exchange.mjs close_position '{"exchange":"okx","symbol":"BTC/USDT:USDT","market_type":"swap","confirmed":"true"}'
node scripts/exchange.mjs positions '{"exchange":"okx","market_type":"swap"}'
```

## Stop Loss / Take Profit

Preview:

```bash
node scripts/exchange.mjs set_stop '{"exchange":"okx","symbol":"BTC/USDT:USDT","market_type":"swap","stop_loss":70000,"take_profit":76000}'
```

Execute after confirmation:

```bash
node scripts/exchange.mjs set_stop '{"exchange":"okx","symbol":"BTC/USDT:USDT","market_type":"swap","stop_loss":70000,"take_profit":76000,"confirmed":"true"}'
node scripts/exchange.mjs stop_orders '{"exchange":"okx","symbol":"BTC/USDT:USDT","market_type":"swap"}'
```

## Leverage / Margin Mode

Read contract info first when needed:

```bash
node scripts/exchange.mjs markets '{"exchange":"okx","market_type":"swap","base":"BTC"}'
```

Then ask for confirmation before changing account settings:

```bash
node scripts/exchange.mjs set_trading_params '{"exchange":"okx","symbol":"BTC/USDT:USDT","leverage":10,"margin_mode":"isolated","market_type":"swap"}'
```

Confirmation template:

> 我准备把 OKX BTC/USDT 永续杠杆改为 10x, margin_mode = isolated。这会影响后续这个交易对所有订单的保证金占用和强平距离。确认改吗?

## Other Commands

```bash
node scripts/exchange.mjs positions '{"exchange":"okx","market_type":"swap"}'
node scripts/exchange.mjs balance '{"exchange":"okx"}'
node scripts/exchange.mjs open_orders '{"exchange":"okx","symbol":"BTC/USDT"}'
node scripts/exchange.mjs stop_orders '{"exchange":"okx","symbol":"BTC/USDT:USDT","market_type":"swap"}'
node scripts/exchange.mjs cancel_order '{"exchange":"okx","symbol":"BTC/USDT","order_id":"xxx"}'
node scripts/exchange.mjs save_key '{"exchange":"okx","api_key":"...","api_secret":"...","password":"..."}'
```

## Quantity Rules

- `amount` means base coin amount, for example `0.01 BTC` or `1000 DOGE`.
- Use `cost` when the user specifies a USDT amount, for example "use 10 USDT".
- For contracts, the script converts coin amount to contract size. If the user truly gives contract count, pass `"amount_unit":"contracts"`.

## Supported Exchanges

`Binance`, `OKX`, `Bybit`, `Bitget`, `Gate.io`, `HTX`.
