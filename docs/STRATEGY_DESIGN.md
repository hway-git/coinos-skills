# PA Expectation Strategy 设计手册

## 1. 策略立意

本策略以 Al Brooks Price Action 理论为主要市场解释框架。

核心原则：

> PA 解释市场，MACD 判断动能，RSI 判断控制权，背离识别价格与动能的不确认，Signal Bar 负责触发交易。

策略目标不是预测价格，而是：

1. 判断当前市场正在做什么。
2. 判断市场参与者正在尝试什么。
3. 建立下一阶段价格行为预期。
4. 使用技术指标验证该预期。
5. 在价格行为确认后寻找入场。
6. 当市场否定原预期时退出。

## 2. 核心模型

```text
Market Context
↓
PA Setup
↓
Expectation
↓
Momentum / Regime / Divergence Evidence
↓
Trade Hypothesis
↓
PA Trigger
↓
Entry
```

PA 始终拥有最高解释优先级。

## 3. PA Core

PA Core 输出：

```yaml
market:
  cycle: channel
  direction: bear
  always_in: short

setup:
  type: l2

expectation:
  type: second_leg
  direction: bear
```

支持的 Market Cycle：

- trend
- channel
- trading_range
- breakout_mode

支持的 Setup：

- h1 / h2
- l1 / l2
- wedge
- double_top / double_bottom
- major_trend_reversal
- breakout
- failed_breakout
- breakout_pullback

支持的 Expectation：

- continuation
- second_leg
- pullback
- reversal
- range_rotation
- breakout
- failed_breakout

Setup 不等于 Signal。Expectation 必须先于 Entry。

## 4. MACD Momentum Model

MACD 不产生交易方向，只描述动能。

```yaml
macd:
  momentum: bull | bear | neutral
  phase: expanding | weakening | crossing | neutral
```

解释：

- bull + expanding：多头动能增强
- bull + weakening：多头仍占动能优势，但正在衰减
- bear + expanding：空头动能增强
- bear + weakening：空头动能正在衰减

MACD 金叉或死叉不得直接产生交易。

## 5. RSI Regime Model

RSI 用于判断市场控制权，而非简单超买超卖。

默认 Regime：

- RSI > 55：bull
- RSI < 45：bear
- RSI 45–55：neutral

Behavior：

- holding
- rejecting
- breaking
- recovering

```yaml
rsi:
  regime: neutral
  behavior: rejecting_bull
```

RSI 的核心问题：

> 当前市场控制权是否支持 PA Expectation？

## 6. Divergence Model

背离表示价格推进没有得到动能确认。

支持：

- MACD regular / hidden divergence
- RSI regular / hidden divergence
- bull / bear
- weak / clear

```yaml
divergence:
  source: macd
  type: regular
  direction: bear
  strength: clear
```

定义：

- Regular Bear：Price HH，Indicator LH
- Regular Bull：Price LL，Indicator HL
- Hidden Bull：Price HL，Indicator LL
- Hidden Bear：Price LH，Indicator HH

背离属于 Momentum Non-confirmation Evidence，不得直接触发交易。

## 7. Trade Hypothesis

状态：

- watching
- armed
- confirmed
- rejected

### WATCHING

PA 已产生明确 Expectation，但指标证据不足。

### ARMED

PA Expectation 获得语义一致的指标支持。

### CONFIRMED

出现 PA Entry Trigger，允许进入执行阶段。

### REJECTED

市场明显否定原 Expectation。

禁止使用简单指标数量投票。

正确方式是建立语义证据链：

```text
Bear Expectation
+
Opponent Momentum Weakening
+
Bull Control Failure
+
Momentum Non-confirmation
```

## 8. Signal Bar

Signal Bar 是 Trigger，不负责创建 Expectation。

基础类型：

- bull_bar
- bear_bar
- doji
- strong_bull_bar
- strong_bear_bar

质量：

- good
- acceptable
- bad

顺序必须是：

```text
Context
↓
Setup
↓
Expectation
↓
Signal Bar
```

## 9. Entry Model

### Stop Entry

用于等待 PA 确认。

例如：

```text
Bear L2
+
Expected Second Leg Down
+
Bull Momentum Weakening
+
RSI Reject Bull Regime
+
Strong Bear Signal Bar
=
Sell Stop Below Signal Bar
```

### Limit Entry

仅用于 PA 已产生明确价格测试预期。

例如：

```text
Bear Breakout
+
Strong Follow Through
+
Expected Breakout Pullback
=
Limit Entry Near Breakout Point
```

禁止因为“涨多了”“跌多了”“感觉会回调”挂限价单。

## 10. Invalidation

每个 Hypothesis 必须定义失效条件。

Invalidation 与 Risk Stop 分离：

- Invalidation：交易逻辑失效
- Risk Stop：最大允许亏损

策略不得因为 Risk Stop 尚未触发而忽略 PA Invalidation。

## 11. 标准流程

1. Identify Market Context
2. Detect PA Setup
3. Generate Expectation
4. Create Trade Hypothesis
5. Read MACD Momentum
6. Read RSI Regime
7. Detect Divergence
8. Evaluate Evidence
9. WATCHING → ARMED
10. Wait For PA Trigger
11. ARMED → CONFIRMED
12. Select Stop Entry or Limit Entry
13. Execute Risk Model
14. Monitor PA Invalidation

## 12. 核心约束

1. PA 拥有最高市场解释优先级。
2. MACD 不直接产生 BUY / SELL。
3. RSI 不使用简单 70/30 作为反转信号。
4. Divergence 不直接产生交易。
5. Setup 不等于 Signal。
6. Expectation 必须先于 Entry。
7. Stop Entry 必须存在 PA Trigger。
8. Limit Entry 必须存在明确价格测试 Expectation。
9. 指标用于验证或反对 PA Hypothesis。
10. 所有交易必须存在 Invalidation。
11. 不使用指标数量投票。
12. 不使用模糊的“多指标共振”作为理由。

## 13. 策略哲学

> PA 定义市场剧本。

> MACD 描述动能变化。

> RSI 描述市场控制权。

> Divergence 描述价格与动能的不确认。

> Signal Bar 证明市场开始执行剧本。

> Entry 只发生在一个可解释的 Trade Hypothesis 中。

## 14. HelixIntradayStrategy 当前实现

时间框架职责：

- `1h`：识别 market cycle、direction 和 always-in state。
- `15m`：优先识别 PA setup 与 expectation。
- `5m`：允许识别更细粒度 setup，并负责 closed-bar entry confirmation。

当前可执行 Setup：

- Trend / Channel 中的 H2、L2 second entry。
- Strong breakout + follow through 后的 breakout pullback。
- Trading Range / Breakout Mode 边缘的 failed breakout。

明确不交易：

- Trading Range 中部。
- 尚未选择方向的 Breakout Mode。
- 只有 EMA、MACD、RSI 或 divergence，没有 PA setup 的场景。
- Signal Bar 尚未被后续闭合 K 线确认的场景。

Freqtrade 当前使用 closed-bar confirmation 模拟 Stop Entry：

```text
PA Setup
↓
Signal Bar closes
↓
Later candle closes beyond Signal Bar high / low
↓
Enter on the next executable price
```

这比使用同一根 OHLC 的 `high/low` 推断 stop order 已成交更保守，但避免在无法知道柱内事件顺序时产生乐观回测。

辅助证据语义：

- EMA20：价格位置与 slope 不得明显反对 expectation。
- MACD：histogram 方向或变化必须支持预期方向，或存在同方向已确认 divergence。
- RSI14：多头使用 `> 55`、空头使用 `< 45` 作为控制权门禁；不把 70/30 当作反转触发器。
- Opposing divergence 在有效窗口内会阻止 hypothesis armed。

Confidence 不是指标投票结果，只表示已成立 hypothesis 的语义质量：

- `70`：可执行 setup，context 与辅助证据一致。
- `80`：high-quality setup，context 与辅助证据一致。
- `85`：high-quality continuation setup，且处于一致的 trend / channel context。

风险层保持独立：结构 invalidation 决定初始 stop，单笔账户风险上限 `0.5%`，最大 stop distance `3 ATR`，目标 `2R`。PA hypothesis 被市场明确否定时可以先于 risk stop 退出。
