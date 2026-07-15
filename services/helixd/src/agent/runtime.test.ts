import assert from 'node:assert/strict'
import test from 'node:test'
import { buildHelixAnalystInstructions } from './runtime'

test('Analyst instructions include versioned strategy doctrine and restored scope', () => {
  const instructions = buildHelixAnalystInstructions(
    { symbol: 'BTC/USDT', timeframe: '15m' },
    null,
  )

  assert.match(instructions, /BTC\/USDT \/ 15m/)
  assert.match(instructions, /helix-agent-strategy-doctrine\/v1/)
  assert.match(instructions, /Market Context → PA Setup → Expectation/)
  assert.match(instructions, /禁止指标投票/)
  assert.match(instructions, /不得补写缺失的 Setup/)
  assert.match(instructions, /长期记忆工具状态：unavailable/)
  assert.match(instructions, /禁止写入价格、指标、当前 Setup\/Hypothesis/)
  assert.match(instructions, /图表注释必须引用 readMarketState 返回的 Evidence ref/)
})

test('Analyst restores only retrieved memories and current intent takes priority', () => {
  const instructions = buildHelixAnalystInstructions(
    { symbol: 'ETH/USDT', timeframe: '5m' },
    null,
    [{ id: 'm1', memory: '用户偏好客观分析', categories: ['analysis-habit'] }],
    true,
    '用户上次在等待 15m 闭合确认。',
  )
  assert.match(instructions, /用户偏好客观分析/)
  assert.match(instructions, /长期记忆工具状态：available/)
  assert.match(instructions, /当前用户明确意图优先于长期 Memory/)
  assert.match(instructions, /用户上次在等待 15m 闭合确认/)
})
