# PA Core 设计规范 v0.1

## 1. 目标

PA Core 负责解释价格行为。

输入：

```text
OHLC Kline
```

输出：

```text
Market Context
PA Setup
Expectation
Signal Bar
Invalidation Evidence
```

PA Core 不负责仓位、风险金额、下单、止盈或指标融合。

核心问题：

> 当前市场处于什么环境？

> 当前价格正在尝试做什么？

> 下一阶段最合理的价格预期是什么？

## 2. 核心输出

```yaml
market:
  cycle: channel
  direction: bear
  always_in: short

setup:
  type: l2
  state: active

expectation:
  type: second_leg
  direction: bear

signal:
  type: strong_bear_bar
  quality: good
```

禁止输出“看起来偏空”“感觉可能下跌”等模糊事实声明。

## 3. Market Cycle

支持：

- trend
- channel
- trading_range
- breakout_mode

### Trend

特征：

- 连续趋势 K 线
- 较低 K 线重叠
- 明显突破
- 持续 Follow Through
- 回调较浅

### Channel

趋势仍存在，但双向交易增加。

特征：

- 保持趋势方向
- 存在 Pullback
- 出现 H1/H2 或 L1/L2
- K 线重叠增加
- 趋势未被明显否定

常见演化：

```text
Trend
↓
Channel
↓
Trading Range
```

### Trading Range

特征：

- 大量 K 线重叠
- 突破失败增加
- 上下边界反复测试
- Follow Through 较差
- 双方均能产生有效推进

区间中部 Setup 应降低质量评级。

### Breakout Mode

特征：

- 波动收缩
- K 线重叠
- 高低点距离缩小
- 方向不明确

不得提前预测突破方向。

## 4. Market Direction

支持：

- bull
- bear
- neutral

综合考虑：

- 价格推进方向
- Swing Progress
- Breakout
- Follow Through
- Pullback Quality

Bull：向上推进有效，向下回调失败。

Bear：向下推进有效，向上回调失败。

Neutral：双方推进均无法持续。

## 5. Always In State

支持：

- long
- short
- neutral

Always In 表示：

> 如果必须持有一个方向，当前更合理的方向是什么？

它不等于交易信号。

## 6. Leg

Leg 是一段有明确方向的价格推进。

```yaml
leg:
  direction: bull
  start_bar: 100
  end_bar: 112
  strength: strong
```

Leg 是 H1/H2、L1/L2、Wedge 与 Second Leg 的基础。

优先描述市场推进，不追求数学上的完美 Swing。

## 7. Pullback

Pullback 是针对当前主要方向的反向推进。

```yaml
pullback:
  direction: bull
  against: bear
  state: active
```

Pullback 结束后可能产生：

- trend_continuation
- second_leg
- reversal
- trading_range

## 8. H1 / H2 / L1 / L2

H1：Bull Context 中第一次恢复上涨尝试。

H2：Bull Context 中第二次恢复上涨尝试。

L1：Bear Context 中第一次恢复下跌尝试。

L2：Bear Context 中第二次恢复下跌尝试。

核心不是数 K 线，而是：

```text
Trend Context
+
Pullback
+
Continuation Attempt Count
```

PA Core 必须维护 continuation_attempt_count，并在 Context 改变时重置。

## 9. Second Leg Expectation

当出现：

```text
Strong First Leg
+
Pullback
```

PA Core 应评估 Second Leg。

Second Leg 不要求创新高或创新低。

它表示：

> 第一段推进后，市场仍存在再次向同方向测试的合理预期。

可能结果：

- new extreme
- double top
- double bottom
- failed second leg

## 10. Wedge

Wedge 定义为同方向三次推进尝试：

```text
Push 1
Pullback
Push 2
Pullback
Push 3
```

Wedge 默认增强反方向两腿调整预期。

Strong Trend 中的 Wedge 优先解释为 minor reversal / pullback，而不是直接解释为 Major Trend Reversal。

## 11. Double Top / Double Bottom

Double Top：两次向相近高位推进，第二次未形成明显有效突破。

Double Bottom：两次向相近低位推进，第二次未形成明显有效突破。

价格接近程度应使用波动归一化，例如 ATR tolerance。

Pattern 的意义必须结合 Market Context。

## 12. Breakout

Breakout 表示价格明显离开已有价格区域。

判断考虑：

- Breakout Bar
- Close Location
- Bar Size
- Overlap
- Follow Through

Breakout 必须等待后续行为判断质量。

## 13. Follow Through

支持：

- strong
- weak
- absent

Strong Follow Through 增强：

- continuation
- second_leg
- breakout_pullback

Absent Follow Through 增强：

- failed_breakout
- trading_range
- reversal_attempt

## 14. Failed Breakout

Failed Breakout：

> 市场突破后无法获得 Follow Through，并重新进入原价格区域。

其 Expectation 由 Context 决定，可能包括：

- test opposite side
- range rotation
- two-legged correction

## 15. Breakout Pullback

定义：

```text
Breakout
+
Follow Through
+
Return To Breakout Area
```

PA Core 应输出 breakout point reference。

Breakout Pullback 是 Limit Entry 的重要价格预期来源。

## 16. Major Trend Reversal

至少需要：

```text
Existing Trend
+
Trend Weakening
+
Important Test
+
Reversal Attempt
+
Trend Structure Change
```

典型 Evidence：

- Wedge
- Double Top / Bottom
- Strong Opposite Breakout
- Follow Through
- Failed Continuation

状态：

- developing
- confirmed
- failed

PA Core 应谨慎输出 confirmed。

大多数 Reversal Attempt 默认属于 minor reversal。

## 17. Signal Bar

基础类型：

- bull_bar
- bear_bar
- doji

质量：

- good
- acceptable
- bad

Short Setup 的 Good Bear Signal Bar 优先具备：

- Bear Body
- Close Near Low
- Reasonable Body Size
- Limited Lower Tail
- Not Excessively Large

Signal Bar 不创建 Setup。

顺序：

```text
Context
↓
Setup
↓
Expectation
↓
Signal Bar
```

## 18. Expectation Engine

根据：

```text
Market Context
+
Current Setup
+
Recent Behavior
```

产生：

- continuation
- second_leg
- pullback
- reversal
- range_rotation
- breakout
- failed_breakout

必须允许 primary 与 secondary expectation。

```yaml
expectation:
  primary:
    type: second_leg
    direction: bear

  secondary:
    type: trading_range
    direction: neutral
```

市场解释不得假装只有唯一结果。

## 19. PA Quality

Setup Quality：

- high
- medium
- low

Quality 必须 Context-aware。

例如：

- L2 in Bear Channel：high
- L2 in Trading Range Middle：low
- Failed Breakout at Range High：high
- Failed Breakout in Range Middle：low

禁止简单打分总和替代语义判断。

## 20. 标准输出协议

```yaml
market:
  cycle: channel
  direction: bear
  always_in: short

current_leg:
  direction: bull
  type: pullback

setup:
  type: l2
  direction: bear
  state: active
  quality: high

behavior:
  follow_through:
    direction: bull
    quality: weak

expectation:
  primary:
    type: second_leg
    direction: bear

  secondary:
    type: trading_range
    direction: neutral

signal:
  type: bear_bar
  quality: good

references:
  signal_bar_low: 61220
  pullback_high: 61580
```

PA Core 不输出 BUY、SELL、POSITION_SIZE 或 LEVERAGE。

## 21. 实现原则

PA Core 优先采用状态演化模型：

```text
Market State
↓
Leg State
↓
Pullback State
↓
Attempt State
↓
Setup Recognition
↓
Expectation
```

不要将系统退化为互相独立、缺乏 Context 的形态识别器集合。

核心原则：

> Context first.

> Setup second.

> Expectation before signal.

> Signal before entry.
