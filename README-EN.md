<div align="center">

<pre>
 ██████╗ ██████╗ ██╗███╗   ██╗ ██████╗ ███████╗
██╔════╝██╔═══██╗██║████╗  ██║██╔═══██╗██╔════╝
██║     ██║   ██║██║██╔██╗ ██║██║   ██║███████╗
██║     ██║   ██║██║██║╚██╗██║██║   ██║╚════██║
╚██████╗╚██████╔╝██║██║ ╚████║╚██████╔╝███████║
 ╚═════╝ ╚═════╝ ╚═╝╚═╝  ╚═══╝ ╚═════╝ ╚══════╝
</pre>

### `> Crypto market data, trading & quant automation for AI agents_`

<br />

[![Version](https://img.shields.io/badge/v2.0.0-blueviolet?style=for-the-badge&logo=semver&logoColor=white)](https://github.com/aicoincom/coinos-skills/releases)
[![JavaScript](https://img.shields.io/badge/ESM-f7df1e?style=for-the-badge&logo=javascript&logoColor=black)](https://nodejs.org/)
[![AiCoin API](https://img.shields.io/badge/AiCoin_API-00d4aa?style=for-the-badge&logo=bitcoin&logoColor=white)](https://www.aicoin.com/opendata)
[![License](https://img.shields.io/badge/MIT-License-f59e0b?style=for-the-badge&logo=opensourceinitiative&logoColor=white)](./LICENSE)
[![Skills](https://img.shields.io/badge/Skills-6_included-ff6b6b?style=for-the-badge&logo=openai&logoColor=white)](./skills/)

<br />

[简体中文](./README.md) · [English](./README-EN.md)

<br />

<img src="https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/rainbow.png" alt="-----" />

</div>

<div align="center">

## What is CoinOS?

**One sentence to query. One sentence to trade. One sentence to backtest.**

</div>

<div align="center">

CoinOS is a collection of AI skills wrapping the [AiCoin Open API](https://www.aicoin.com/opendata) and OKX Web3 DEX API — bringing real-time crypto market data, exchange trading, Freqtrade strategy automation, Hyperliquid whale analytics, and on-chain DEX trading to any AI agent.

Works with **Claude Code, Cursor, Codex, OpenClaw, Hermes, WorkBuddy, Windsurf, Gemini CLI** and more.

</div>

<div align="center">

<table>
<tr><td>

- No API key needed — **built-in free key** works out of the box
- All data from **AiCoin**, the leading crypto analytics platform
- **6 skills**, each self-contained and independently installable

</td></tr>
</table>

<br />
<img src="https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/rainbow.png" alt="-----" />

## Skill Matrix

</div>

<div align="center">
<table>
<tr>
<td width="50%">

**Market Intelligence**

| Skill | Capability |
|:--|:--|
| **aicoin-market** | Prices, K-lines, funding rates, OI, whale orders, news, signals, airdrops, drop radar |

</td>
<td width="50%">

**Exchange Trading**

| Skill | Capability |
|:--|:--|
| **aicoin-trading** | Buy/sell across Binance, OKX, Bybit & 5 more exchanges, automated trading strategies |

</td>
</tr>
<tr>
<td width="50%">

**Quant Automation**

| Skill | Capability |
|:--|:--|
| **aicoin-freqtrade** | Strategy creation with AiCoin indicators, backtesting, hyperopt, live bot deployment |

</td>
<td width="50%">

**Whale Analytics**

| Skill | Capability |
|:--|:--|
| **aicoin-hyperliquid** | Whale position tracking, liquidation data, trader PnL analytics on Hyperliquid |

</td>
</tr>
<tr>
<td width="50%">

**Account Management**

| Skill | Capability |
|:--|:--|
| **aicoin-account** | Balance & positions, order history, API key management, exchange registration with referral links |

</td>
<td width="50%">

**On-chain DEX**

| Skill | Capability |
|:--|:--|
| **aicoin-onchain** | Token swaps, wallet portfolio/balance, gas estimation, token lookup (OKX Web3, EVM/Solana multi-chain) |

</td>
</tr>
</table>
</div>

<div align="center">
<br />
<img src="https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/rainbow.png" alt="-----" />

## AiCoin Exclusive Data

**Data you can't get anywhere else — aggregated from 200+ exchanges in real time.**

</div>

<div align="center">
<table>
<tr>
<td width="50%">

**Whale & Sentiment Intelligence**

| Data | What it tells you |
|:--|:--|
| **Whale Orders** | Real-time large buy/sell orders across exchanges |
| **Long/Short Ratio** | Aggregated market positioning — are traders net long or short? |
| **Funding Rates** | Cross-exchange weighted rates — spot over-leveraged markets |
| **Liquidation Map** | Heatmap of liquidation clusters — find squeeze zones |
| **Open Interest** | Aggregated OI trends — confirm or question price moves |

</td>
<td width="50%">

**News & Alpha Discovery**

| Data | What it tells you |
|:--|:--|
| **Newsflash** | Breaking crypto news before it hits mainstream |
| **Twitter/X Feed** | Real-time KOL tweets, influencer discovery |
| **Drop Radar** | Airdrop intelligence: team, funding, X followers, status |
| **Signal Alerts** | Pre-built anomaly & strategy signals |
| **Treasury Tracker** | Institutional holdings (MicroStrategy, funds, etc.) |

</td>
</tr>
</table>
</div>

<div align="center">

> Most platforms give you prices. AiCoin gives you **what the whales are doing, what the market is feeling, and what's about to happen** — across 200+ exchanges, in one API.

<br />
<img src="https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/rainbow.png" alt="-----" />

## Strategy & Backtesting

**Write strategies in one sentence. Backtest with real data. Deploy to live.**

</div>

CoinOS integrates with [Freqtrade](https://github.com/freqtrade/freqtrade) and injects **AiCoin's exclusive on-chain/sentiment data** directly into your strategies — something no other backtesting tool offers.

<div align="center">
<table>
<tr>
<td width="50%">

**17 Built-in Indicators**

| Category | Indicators |
|:--|:--|
| **Trend** | EMA, SMA, ADX, Ichimoku |
| **Momentum** | RSI, MACD, Stochastic/KDJ, CCI, Williams %R |
| **Volatility** | Bollinger Bands, ATR |
| **Volume** | VWAP, OBV, Volume SMA |

</td>
<td width="50%">

**5 AiCoin-Exclusive Data Feeds**

| Data | Strategy use case |
|:--|:--|
| **funding_rate** | Rate > 0.1% = too many longs, fade the crowd |
| **ls_ratio** | Ratio < 0.45 = crowded shorts, contrarian buy |
| **big_orders** | Positive whale signal = smart money accumulating |
| **liquidation_map** | Liquidation clusters = squeeze opportunity |
| **open_interest** | OI rising + price falling = reversal incoming |

</td>
</tr>
</table>
</div>

<div align="center">

**One command to create. One command to backtest. One command to deploy.**

</div>

```bash
# 1. Create a strategy with AiCoin data + technical indicators
> "Write a funding rate strategy with RSI and Bollinger Bands, 15m timeframe"

# 2. Backtest against real historical K-line data
> "Backtest it on BTC/USDT, all of 2025"

# 3. Optimize parameters
> "Run hyperopt, 500 epochs"

# 4. Deploy to live
> "Deploy it as a dry-run bot on Binance"
```

```
Backtest Results
─────────────────────────────────────────────────
Strategy:       FundingRateStrat
Timerange:      2025-01-01 → 2025-12-31
Pair:           BTC/USDT
─────────────────────────────────────────────────
Total trades:   142
Win rate:       63.4%
Total profit:   +18.7%
Max drawdown:   -8.2%
Sharpe ratio:   1.45
─────────────────────────────────────────────────
AiCoin data:    funding_rate (live/dry-run only)
Indicators:     RSI, Bollinger Bands
─────────────────────────────────────────────────
```

<div align="center">

> Traditional backtesting only uses price + volume. CoinOS strategies can additionally react to **whale behavior, market sentiment, and liquidation pressure** in live trading — giving your bot an edge that pure technical analysis can't match.

<br />
<img src="https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/rainbow.png" alt="-----" />

## Architecture

</div>

```
                              ┌──────────────────────┐
                              │   AI Agent (NL)       │
                              └───────────┬──────────┘
                                          │
                              ┌───────────▼──────────┐
                              │     CoinOS Skills     │
                              └───────────┬──────────┘
                                          │
     ┌──────────┬──────────┬─────────────┼──────────┬──────────┐
  ┌──▼───┐ ┌────▼───┐ ┌────▼────┐ ┌──────▼──┐ ┌─────▼───┐ ┌────▼────┐
  │market│ │trading │ │freqtrade│ │  hyper  │ │ account │ │ onchain │
  │      │ │        │ │         │ │ liquid  │ │         │ │  DEX    │
  │aicoin│ │exchange│ │ft-deploy│ │ aicoin  │ │exchange │ │  swap   │
  │ .mjs │ │  .mjs  │ │  .mjs   │ │  .mjs   │ │  .mjs   │ │  .mjs   │
  └──┬───┘ └───┬────┘ └────┬────┘ └────┬────┘ └────┬────┘ └────┬────┘
     │         │           │           │           │           │
     └─────────┴─────┬─────┴───────────┘           │           │
                     │                             │           │
          ┌──────────▼──────────┐      ┌───────────▼─────┐ ┌───▼──────────┐
          │   AiCoin Open API   │      │   Exchange APIs  │ │ OKX Web3 API │
          │  (market data layer)│      │ Binance/OKX/…   │ │  (on-chain)  │
          └─────────────────────┘      └─────────────────┘ └──────────────┘
```

<div align="center">

Each skill is **self-contained** with its own `SKILL.md`, `lib/`, and `scripts/`. `aicoin-market` and `aicoin-hyperliquid` each use a single catalog-driven v3 client (`scripts/aicoin.mjs` + `lib/client.mjs`) that can call any of the 183 AiCoin Open API v3 endpoints; `aicoin-onchain` uses a standalone OKX Web3 DEX client (`lib/okx-api.mjs`).

<br />
<img src="https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/rainbow.png" alt="-----" />

## Quick Start

</div>

```bash
# Install via npx
npx skills add aicoincom/coinos-skills

# Select which skills to install, or use --yes to install all 6
```

<div align="center">

Then, just talk to your AI agent:

</div>

```
> "What's the BTC price right now?"
> "Show me ETH 1h K-line"
> "Write a funding rate strategy"
> "Check my OKX balance"
> "What direction are BTC whales on Hyperliquid?"
> "Swap 0.1 ETH for USDC on-chain"
```

<div align="center">

Market data needs no configuration — a built-in free API key works out of the box. Add exchange or OKX Web3 keys only when you want to trade or go on-chain.

<br />
<img src="https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/rainbow.png" alt="-----" />

## Supported Exchanges

| Exchange | ID | Spot | Futures | |
|:--|:--|:--:|:--:|:--|
| **Binance** | `binance` | ✅ | ✅ | World's largest by volume |
| **OKX** | `okx` | ✅ | ✅ | Advanced derivatives platform |
| **Bybit** | `bybit` | ✅ | ✅ | Leading perpetuals exchange |
| **Bitget** | `bitget` | ✅ | ✅ | Copy-trading leader |
| **Gate.io** | `gate` | ✅ | ✅ | 1700+ trading pairs |
| **HTX** | `htx` | ✅ | ✅ | Global digital asset platform |
| **Pionex** | `pionex` | ✅ | ✅ | Grid / quant-bot exchange |
| **Hyperliquid** | `hyperliquid` | — | ✅ | On-chain perpetuals DEX (USDC) |

<br />
<img src="https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/rainbow.png" alt="-----" />

## Usage Examples

</div>

<details open>
<summary><strong>Market Data</strong></summary>

```
You:     What's the BTC price right now?

CoinOS:  BTC/USDT — $84,302.50
         24h Change:  +2.34%
         24h High:    $85,100.00
         24h Low:     $82,450.00
         24h Volume:  $28.5B
```

</details>

<details>
<summary><strong>K-line & Technical Analysis</strong></summary>

```
You:     Show me ETH 1h K-line.

CoinOS:  Fetches 100 candles from OKX, returns OHLCV data
         with timestamps, ready for charting or analysis.
```

```bash
# Direct script call
node skills/aicoin-market/scripts/aicoin.mjs market/klines \
  '{"coin_key":"ethereum","market":"okx","interval":"1h","limit":100}'
```

</details>

<details>
<summary><strong>Exchange Trading</strong></summary>

```
You:     Buy 0.1 BTC on Binance

CoinOS:  Order Preview
         ─────────────────────────────────────
         Exchange:    Binance
         Pair:        BTC/USDT
         Side:        BUY
         Type:        Market
         Amount:      0.1 BTC
         Est. Cost:   ~$8,430.25
         ─────────────────────────────────────
         Confirm to execute.
```

</details>

<details>
<summary><strong>On-chain DEX Swap</strong></summary>

```
You:     Swap 0.1 ETH for USDC on-chain

CoinOS:  Swap Quote (Ethereum)
         ─────────────────────────────────────
         Sell:        0.1 ETH
         Buy:         ~316.4 USDC
         Route:       Uniswap V3
         Est. gas:    ~$2.10
         ─────────────────────────────────────
         Confirm to broadcast.
```

</details>

<details>
<summary><strong>Strategy & Backtesting</strong></summary>

```
You:     Write a funding rate strategy, 15m timeframe

CoinOS:  Creating strategy via ft-deploy.mjs...
         ✓ Strategy "FundingRateStrat" created
         ✓ Timeframe: 15m
         ✓ AiCoin data: funding_rate
         ✓ File: user_data/strategies/FundingRateStrat.py

You:     Backtest it, all of 2025

CoinOS:  Running backtest...
         ─────────────────────────────────────
         Strategy:    FundingRateStrat
         Timerange:   2025-01-01 → 2025-12-31
         Total trades: 142
         Win rate:     63.4%
         Total profit: +18.7%
         Max drawdown: -8.2%
         Sharpe ratio: 1.45
```

</details>

<details>
<summary><strong>Hyperliquid Whale Tracking</strong></summary>

```
You:     What direction are BTC whales on Hyperliquid?

CoinOS:  Top BTC Whale Positions (Hyperliquid)
         ─────────────────────────────────────
         🐋 0x1a2b...  LONG   $12.5M   +$340K PnL
         🐋 0x3c4d...  SHORT  $8.2M    -$120K PnL
         🐋 0x5e6f...  LONG   $6.8M    +$89K  PnL
         ─────────────────────────────────────
         Net bias: 65% LONG
```

</details>

<div align="center">
<br />
<img src="https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/rainbow.png" alt="-----" />

## Environment Variables

</div>

Put your keys in **`~/.coinos/.env`** (recommended — read no matter which directory you run scripts from). Scripts auto-load in this order: container `/workspace/.env` → `~/.coinos/.env` (canonical) → cwd `.env` → legacy `~/.openclaw/workspace/.env`, `~/.openclaw/.env` (backward-compat). You can also `export` them in your shell (env vars take highest priority):

```bash
# AiCoin API (optional — built-in free key works with IP rate limits)
AICOIN_ACCESS_KEY_ID="your-key"
AICOIN_ACCESS_SECRET="your-secret"

# Exchange trading (aicoin-trading / aicoin-account, only if needed)
BINANCE_API_KEY="xxx"
BINANCE_API_SECRET="xxx"
# Supported: BINANCE, OKX, BYBIT, BITGET, GATE, HTX, PIONEX, HYPERLIQUID
# OKX / Bitget also need a passphrase: OKX_PASSWORD="xxx"

# On-chain DEX swap / wallet (aicoin-onchain, OKX Web3 DEX API)
# Note: a separate key set from the CEX trading keys above
OKX_WEB3_API_KEY="xxx"
OKX_WEB3_SECRET_KEY="xxx"
OKX_WEB3_PASSPHRASE="xxx"

# Proxy (optional — for local networks that can't reach exchanges/OKX directly; socks5h supported)
PROXY_URL="socks5://127.0.0.1:7890"
```

<div align="center">
<br />
<img src="https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/rainbow.png" alt="-----" />
</div>

<details>
<summary><strong>Project Structure</strong></summary>

<br />

```
coinos-skills/
├── skills/
│   ├── aicoin-market/        # Prices, K-lines, news, signals, airdrops
│   │   ├── SKILL.md
│   │   ├── lib/
│   │   └── scripts/
│   │       └── aicoin.mjs        One CLI → all 183 AiCoin v3 endpoints (catalog-driven)
│   │
│   ├── aicoin-trading/       # Exchange trading
│   │   ├── SKILL.md
│   │   ├── lib/
│   │   └── scripts/
│   │       ├── exchange.mjs      Orders, balance, positions
│   │       ├── trade.mjs         Order-flow wrapper
│   │       ├── auto-trade.mjs    Automated trading strategies
│   │       └── register.mjs      Exchange registration
│   │
│   ├── aicoin-freqtrade/     # Strategy automation
│   │   ├── SKILL.md
│   │   ├── lib/                  coinclaw-env / freqtrade-api / strategy-builder / aicoin_data.py
│   │   └── scripts/
│   │       ├── ft-deploy.mjs     Create, backtest, deploy bots
│   │       ├── ft.mjs            Freqtrade daemon control
│   │       └── ft-dev.mjs        Strategy dev / debug helpers
│   │
│   ├── aicoin-hyperliquid/   # Whale analytics
│   │   ├── SKILL.md
│   │   ├── lib/
│   │   └── scripts/
│   │       └── aicoin.mjs        One CLI → all Hyperliquid v3 endpoints
│   │
│   ├── aicoin-account/       # Account management
│   │   ├── SKILL.md
│   │   ├── lib/
│   │   └── scripts/
│   │       ├── exchange.mjs      Balance, positions, orders
│   │       ├── api-key-info.mjs  API key management
│   │       ├── check-tier.mjs    Verify API tier/subscription
│   │       └── register.mjs      Exchange registration
│   │
│   └── aicoin-onchain/       # On-chain DEX trading
│       ├── SKILL.md
│       ├── lib/
│       │   └── okx-api.mjs       OKX Web3 DEX client
│       └── scripts/
│           ├── swap.mjs          Quote & swap execution
│           ├── portfolio.mjs     Wallet balance / portfolio
│           ├── market.mjs        On-chain market data
│           ├── token.mjs         Token search / info
│           ├── trade.mjs         Transaction broadcasting
│           └── gateway.mjs       Chain / gateway
│
├── AGENTS.md                 # Skill routing for AI agents
├── CLAUDE.md                 # Dev instructions
└── .claude-plugin/
    └── plugin.json           # Plugin metadata
```

</details>

<div align="center">

<br />

## License

[MIT License](./LICENSE)

<br />

<img src="https://raw.githubusercontent.com/andreasbm/readme/master/assets/lines/rainbow.png" alt="-----" />

<br />

**Powered by** [AiCoin Open API](https://www.aicoin.com/opendata) · [OKX Web3 DEX API](https://web3.okx.com) · [CCXT](https://github.com/ccxt/ccxt) · [Freqtrade](https://github.com/freqtrade/freqtrade)

<br />

```
Built for AI-native crypto trading.
```

<br />

<sub>Made by <a href="https://www.aicoin.com">AiCoin</a></sub>

</div>
