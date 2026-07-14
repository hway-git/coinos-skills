# 交易分析 Agent 设计手册

## 1. Agent 定位

交易分析 Agent 是既有策略能力与用户之间的交互层。

Agent 不负责定义或修改交易策略，也不自行创造新的市场理论。

职责：

> 调用既有策略能力持续分析市场，并通过记忆保持跨对话的认知连续性。

核心目标：

> 不要每次重新分析市场，而是持续跟踪市场故事。

## 2. 技术边界

Agent 使用：

- Vercel AI SDK
- AI SDK UI
- Mem0

除非发现明确能力缺口，否则不引入其他 Agent Framework。

### 2.1 运行时边界

Agent Runtime 是 `helixd` 常驻进程中的独立模块。

`helixd` 负责：

- Agent Run 编排
- 模型与 Tool Calling
- Market Story 与 Analysis 状态持久化
- 长期 Memory 接入
- 定时与事件触发
- 权限、审计和失败恢复

Dashboard 只负责：

- 传递当前 Symbol、Timeframe 与用户消息
- 消费 Agent 流式响应
- 展示 Market Story、Tool Result 与交互式界面

禁止在 Dashboard 内实现 Agent Runtime、访问 Agent 数据库或直接持有模型密钥。

策略、行情、账户与执行能力通过 `helixd` 的稳定 Tool Adapter 提供。Agent 不依赖 Dashboard 内部模块。

## 3. Vercel AI SDK 职责

负责：

- 模型调用
- 流式响应
- Tool Calling
- 对话消息状态
- 结构化 Tool Result
- Generative UI

AI SDK 不负责长期记忆。

## 4. Mem0 职责

Mem0 负责长期语义记忆。

主要保存：

- 用户交易偏好
- 用户分析习惯
- 用户长期交易纪律
- 反复出现的行为模式
- 用户明确认可的重要经验
- 长期有效的交流偏好

Mem0 用于回答：

```text
这个交易者是谁？
他习惯怎么看盘？
他关注什么？
他容易犯什么错误？
他制定过什么纪律？
```

Mem0 不作为实时市场状态的数据源。

## 5. Agent 基本运行流程

```text
理解用户意图
↓
搜索相关长期记忆
↓
加载当前分析上下文
↓
调用必要工具
↓
获取事实与策略分析结果
↓
结合记忆进行解释
↓
生成回答
↓
必要时生成交互式图表
↓
判断是否产生新的长期记忆
```

原则：

> 先获得事实，再生成观点。

禁止先生成市场观点，再寻找证据。

## 6. Agent Context

每次 Run 构建临时 Agent Context：

```yaml
agent_context:
  user_memories:
    - prefers_objective_analysis
    - prefers_second_leg_setup

  conversation:
    recent_messages: []

  market:
    symbol: BTC-USDT

  previous_analysis:
    id: analysis_001

  active_hypothesis:
    id: hypothesis_001
    state: armed
```

Agent Context 只服务当前 Run，不等于长期 Memory。

## 7. Memory Retrieval

不得加载全部记忆。

必须根据当前问题检索相关 Memory。

例如“现在 BTC 怎么看？”应关注：

- 分析习惯
- 常用周期
- 交易风格
- 行情分析偏好

“这里能空吗？”应关注：

- 空头入场偏好
- 入场纪律
- 止损纪律
- 逻辑失效处理方式
- 偏好的 PA Setup

原则：

> Retrieve Relevant Memory, not Load All Memory.

## 8. Memory Write

仅在以下情况考虑写入 Mem0：

1. 用户明确表达长期偏好。
2. 用户制定长期交易纪律。
3. 用户修正 Agent 对自身交易习惯的理解。
4. 某个行为模式反复出现。
5. 用户明确认可长期经验。
6. 信息未来多次分析仍有价值。

禁止将实时价格、临时指标状态、当前 Setup 或短期持仓事实写入长期 Memory。

## 9. Memory 冲突

当前明确意图优先于 Memory。

```text
Current Explicit Intent > Memory
```

若用户明确表达长期改变，应更新长期 Memory。

Memory 默认静默影响 Agent 行为，不需要反复向用户声明“根据记忆”。

## 10. 对话连续性

新会话不代表新用户。

Agent 应恢复相关用户背景，并优先加载：

- 最近一次有效分析
- 当前 Active Hypothesis
- 最近市场状态变化

Agent 必须优先回答：

```text
上次我们在等什么？
现在发生了什么？
原判断是否仍成立？
下一步等待什么？
```

禁止每次重新生成完整市场背景。

## 11. Active Hypothesis Awareness

处理市场问题前必须检查 Active Hypothesis。

状态：

- watching
- armed
- confirmed
- rejected
- expired

例如昨日等待 Second Leg Down，今日用户问“现在呢？”，Agent 应首先检查该预期是否已经出现。

## 12. 上次分析对比

新的分析应尽可能与上一次有效分析比较。

```yaml
change_since_last_analysis:
  retained: []
  changed: []
  invalidated: []
  new: []
```

自然语言优先描述变化，避免重复背景。

## 13. 每日分析

每日定时分析属于标准 Agent Run：

```text
加载昨日分析
↓
加载 Active Hypothesis
↓
加载相关长期 Memory
↓
获取最新市场数据
↓
调用策略分析能力
↓
与昨日分析比较
↓
更新当前市场认知
↓
更新 Hypothesis
↓
生成每日分析
```

每日分析必须回答：

- 昨天预期什么？
- 市场实际发生了什么？
- 哪些判断仍成立？
- 哪些判断发生变化？
- 当前正在观察什么？
- 下一步等待什么？

## 14. Chat Agent 行为

用户可能使用高度省略的表达：

```text
跌了
突破了
这里呢？
能空吗？
背离还在吗？
L2 失败了？
```

语义恢复优先级：

```text
当前 Conversation
↓
Active Hypothesis
↓
最近有效 Analysis
↓
最近市场上下文
```

只有确实无法判断对象时才要求用户补充。

## 15. 聊天内市场图表

AI SDK UI 负责将结构化 Tool Result 映射为 Lightweight Charts React 组件。

Agent 可调用：

```text
renderMarketChart
```

示例输入：

```yaml
symbol: BTC-USDT
timeframe: 15m
bars: 200

annotations:
  - type: marker
    ref: l1
    text: L1

  - type: marker
    ref: l2
    text: L2

  - type: expectation
    direction: down
    target_zone:
      min: 116500
      max: 116900
```

Agent 不生成图片或 Canvas 代码，只描述图表语义。

## 16. 图表使用原则

图表是 Evidence，不是 Decoration。

优先用于：

- 为什么是 L2？
- 画一下当前通道。
- 这里是不是 Wedge？
- 你预期价格怎么走？
- 关键阻力在哪里？

只绘制与当前回答有关的结构。

## 17. Evidence Reference

重要判断应尽可能关联证据：

```yaml
claim:
  type: setup
  value: l2
  evidence_refs:
    - l1_marker
    - l1_failure_marker
    - l2_marker
```

核心原则：

> 重要 PA 判断必须尽可能可检查。

Agent 可以解释模糊情况，但不得创造证据。

## 18. 默认回答风格

默认结构：

```text
发生了什么变化
↓
当前判断
↓
当前状态
↓
下一步等待什么
```

避免：

- 重复策略理论
- 大量指标定义
- 无关市场知识
- 过度评价用户
- 每次重新写完整行情研报

## 19. Agent 禁止行为

1. 每次对话从零开始。
2. 忽略最近有效分析。
3. 忽略 Active Hypothesis。
4. 将全部聊天写入 Mem0。
5. 将实时行情写入长期 Memory。
6. 使用 Mem0 作为市场事实来源。
7. 创造不存在的市场证据。
8. 绕过现有策略能力自行重新实现策略。
9. 擅自修改策略定义。
10. 为保持旧观点而忽略最新分析结果。
11. 每次回答都生成图表。
12. 将图表作为装饰。

## 20. 核心原则

> AI SDK 负责对话与工具调用。

> AI SDK UI 负责聊天中的结构化界面。

> Mem0 负责记住交易者。

> 现有策略能力负责分析市场。

> Agent 负责连接这些能力。

最终原则：

> Do not restart the analysis.

> Continue the market story.
