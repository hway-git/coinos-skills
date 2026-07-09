#!/usr/bin/env node
// Exchange Registration — outputs neutral exchange registration guidance
// Usage: node scripts/register.mjs <exchange>
// Example: node scripts/register.mjs okx

const EXCHANGES = {
  okx:     { name: 'OKX' },
  binance: { name: 'Binance' },
  bitget:  { name: 'Bitget' },
  htx:     { name: 'HTX' },
  gate:    { name: 'Gate.io' },
  bitmart: { name: 'Bitmart' },
  bybit:   { name: 'Bybit' },
  pionex:  { name: 'Pionex' },
};

// Normalize input: "OKX" -> "okx", "币安" -> "binance", "火币" -> "htx"
const ALIASES = {
  '币安': 'binance', 'bian': 'binance', 'bn': 'binance',
  '火币': 'htx', 'huobi': 'htx',
  '派网': 'pionex',
  'gateio': 'gate', 'gate.io': 'gate',
};

const raw = (process.argv[2] || '').trim().toLowerCase();
const key = ALIASES[raw] || raw;

if (!key || key === 'list') {
  // List all exchanges
  const result = {
    message: '以下是 Helix 支持识别的交易所：',
    exchanges: Object.values(EXCHANGES).map(r => ({
      exchange: r.name,
    })),
    note: '请前往交易所官网或官方 App 注册。用法：node scripts/register.mjs <exchange>',
  };
  console.log(JSON.stringify(result, null, 2));
} else if (EXCHANGES[key]) {
  const r = EXCHANGES[key];
  const result = {
    exchange: r.name,
    registration: '请前往交易所官网或官方 App 注册。',
    steps: [
      `打开 ${r.name} 官网或官方 App 的注册入口`,
      '选择手机号或邮箱注册，填入验证码、设置密码',
      '进入「账户中心」→「身份验证」完成 KYC',
      '如需 API 交易，到「API 管理」创建 API Key，并通过 Helix 安全配置流程写入 .env 文件',
    ],
    security_note: '交易所 API Key 需单独到交易所申请。所有密钥仅保存在本地设备或容器 EnvSection, 不要在 chat 中回显 secret。',
  };
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log(JSON.stringify({
    error: `未知交易所: ${raw}`,
    available: Object.keys(EXCHANGES).join(', '),
    hint: '用法：node scripts/register.mjs okx',
  }));
  process.exit(1);
}
