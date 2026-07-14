# Trading Agent 能力演进设计

## 1. 目标

Trading Agent 当前以市场分析为主要能力。

长期目标覆盖完整交易学习闭环：

```text
Analyze
↓
Plan
↓
Execute
↓
Journal
↓
Review
↓
Improve
↓
Validate
```

本文件描述 Agent 的能力演进方向。

不定义当前 Agent Runtime。

不定义具体交易策略。

## 2. Analyst

当前阶段。

职责：

- 持续分析市场
- 延续历史市场上下文
- 跟踪当前 Hypothesis
- 每日生成市场分析
- 回答实时盘面问题
- 使用图表解释关键判断

核心问题：

> 市场正在做什么？

> 上一次预期是否仍然成立？

> 下一步等待什么？

## 3. Trading Copilot

接入交易系统后，Agent 可以读取：

- Position
- Order
- Fill
- Trade

Agent 将：

```text
Market Analysis
+
Hypothesis
+
Trade Context
```

进行关联。

核心问题：

> 当前持仓是否仍然符合原交易计划？

若出现：

```text
Hypothesis Rejected
+
Position Still Open
```

Agent 应明确指出当前持仓已失去原交易逻辑支持。

默认只开放交易系统读取权限。

交易执行权限必须单独设计。

## 4. Trade Context

每笔交易应尽可能关联：

- Strategy Version
- Analysis
- Hypothesis
- Setup
- Expectation

交易记录不应只有 Symbol、Side、Entry、Exit、PnL。

Agent 必须能够恢复交易发生时的原始分析上下文。

## 5. Trade Journal

交易结束后生成结构化 Trade Journal。

必须区分：

```text
Plan
Execution
Outcome
```

例如：

```yaml
plan:
  entry: signal_bar_break
  invalidation: bull_follow_through

execution:
  entry: market_chase
  invalidation_action: ignored

outcome:
  pnl: -120
  r_multiple: -1.4
```

Agent 必须区分：

- Strategy Failure
- Execution Failure
- Risk Failure
- Behavior Failure

禁止根据最终盈亏直接判断策略好坏。

盈利交易也可能属于错误执行。

亏损交易也可能完全符合策略。

## 6. Reviewer

Agent 支持周期性复盘：

- Weekly Review
- Monthly Review

复盘数据来源：

- Trade Journal
- Analysis History
- Hypothesis History
- Order / Fill Data

Mem0 仅提供长期用户行为背景。

统计结论必须来自真实交易数据。

## 7. 月度复盘

### Strategy

回答：

- 哪些 Setup 表现最好？
- 哪些 Setup 表现最差？
- 不同 Market Context 下表现如何？
- Expectation 命中情况如何？

### Execution

回答：

- 是否提前入场？
- 是否追价？
- 是否错过 Trigger 后强行开仓？
- 实际执行与 Plan 偏离多少？

### Invalidation

回答：

- Hypothesis Rejected 后是否及时退出？
- 平均退出延迟是多少？
- 延迟退出造成多少额外损失？

### Behavior

回答：

- 是否频繁利润回吐？
- 是否在 Range Middle 交易？
- 是否在低质量 Setup 频繁交易？
- 是否出现重复行为错误？

## 8. Strategy Improvement

Agent 不得直接修改策略。

策略改进流程：

```text
Observation
↓
Improvement Hypothesis
↓
Evidence
↓
Backtest
↓
Compare Baseline
↓
Human Review
↓
Accept / Reject
```

示例：

```yaml
observation:
  "L2 without opponent momentum weakening underperformed."

hypothesis:
  "MACD opponent momentum weakening may improve L2 selection."

proposed_change:
  "Require momentum weakening before ARMED."

validation:
  method: backtest
```

该内容只是 Strategy Improvement Hypothesis，不是策略规则。

## 9. Strategy Version Awareness

每笔 Analysis、Hypothesis、Trade、Journal 应关联 Strategy Version。

例如：

```text
strategy_v0.1
strategy_v0.2
```

禁止将不同策略版本的交易混合统计后直接得出策略结论。

## 10. Agent 权限演进

### Level 1

```text
READ_MARKET
READ_ANALYSIS
```

### Level 2

```text
READ_POSITION
READ_ORDER
READ_TRADE
```

### Level 3

```text
CREATE_TRADE_PLAN
CREATE_DRAFT_ORDER
```

创建计划或订单草稿，需要用户确认。

### Level 4

```text
PLACE_ORDER
MODIFY_ORDER
CANCEL_ORDER
```

Level 4 必须单独设计：

- Permission
- Risk Gate
- Audit
- Idempotency
- Failure Recovery

不得默认开放。

## 11. Agent 长期角色

### Analyst

> 市场正在做什么？

### Trading Copilot

> 当前持仓是否仍符合原计划？

### Reviewer

> 最近的问题到底出在哪里？

三个角色共享用户长期上下文，但使用独立任务协议。

## 12. 核心原则

分析：

> Continue the market story.

交易：

> Compare execution with the original plan.

复盘：

> Separate strategy failure from execution failure.

改进：

> Form a hypothesis before changing a rule.

最终目标：

> Build a continuous trading learning loop.
