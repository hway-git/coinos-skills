import {
  createAgentUIStreamResponse,
  safeValidateUIMessages,
  type InferAgentUIMessage,
} from 'ai'
import { randomUUID } from 'node:crypto'
import {
  AGENT_RECENT_MESSAGE_LIMIT,
  DEFAULT_AGENT_CONVERSATION_ID,
  type AgentConversationResponse,
  type AgentStatusResponse,
  type AgentStoryResponse,
} from '@helix/contracts/agent'
import { Hono } from 'hono'
import {
  contextualizeAgentMessages,
  mergeAgentConversation,
  messagesWithAgentSceneContext,
  readAgentConversation,
  writeAgentConversation,
} from '../agent/conversation-store'
import { getAgentMarketContext } from '../agent/market-context'
import { resolveAgentProviderConfig } from '../agent/provider-config'
import { createHelixAnalyst } from '../agent/runtime'
import {
  agentChatRequestSchema,
  agentScopeSchema,
  normalizeAgentScope,
} from '../agent/schemas'
import { readMarketStory } from '../agent/story-store'
import { readJson } from '../http'

export const agentRoutes = new Hono()

agentRoutes.get('/status', (c) => {
  const config = resolveAgentProviderConfig()
  return c.json({
    ok: true,
    service: 'helix-agent',
    model: config.model,
    modelConfigured: config.configured,
    apiMode: config.apiMode,
    customBaseURL: config.customBaseURL,
    configurationError: config.error,
  } satisfies AgentStatusResponse)
})

agentRoutes.get('/story', (c) => {
  const parsed = agentScopeSchema.safeParse({
    symbol: c.req.query('symbol'),
    timeframe: c.req.query('timeframe'),
  })
  if (!parsed.success) return c.json({ ok: false, error: '需要有效的 symbol 和 timeframe' }, 400)

  const scope = normalizeAgentScope(parsed.data)
  return c.json({
    ok: true,
    scope,
    story: readMarketStory(scope),
  } satisfies AgentStoryResponse)
})

agentRoutes.get('/conversation', (c) => {
  return c.json({
    ok: true,
    conversationId: DEFAULT_AGENT_CONVERSATION_ID,
    messages: readAgentConversation(DEFAULT_AGENT_CONVERSATION_ID),
  } satisfies AgentConversationResponse)
})

agentRoutes.post('/chat', async (c) => {
  const providerConfig = resolveAgentProviderConfig()
  if (providerConfig.error) {
    return c.json({ ok: false, error: providerConfig.error }, 503)
  }
  if (!providerConfig.configured) {
    return c.json({ ok: false, error: '未配置 HELIX_OPENAI_API_KEY 或 OPENAI_API_KEY' }, 503)
  }

  const parsed = agentChatRequestSchema.safeParse(await readJson(c))
  if (!parsed.success) return c.json({ ok: false, error: 'Agent 请求格式无效' }, 400)

  const scope = normalizeAgentScope(parsed.data)
  const [story, marketContext] = await Promise.all([
    Promise.resolve(readMarketStory(scope)),
    getAgentMarketContext(scope),
  ])
  const agent = createHelixAnalyst({ scope, story, marketContext, providerConfig })
  const validated = await safeValidateUIMessages<InferAgentUIMessage<typeof agent>>({
    messages: parsed.data.messages,
    tools: agent.tools,
  })
  if (!validated.success) return c.json({ ok: false, error: 'Agent 消息格式无效' }, 400)

  const history = readAgentConversation<InferAgentUIMessage<typeof agent>>(
    DEFAULT_AGENT_CONVERSATION_ID,
  )
  const incoming = contextualizeAgentMessages(history, validated.data, scope)
  const conversation = mergeAgentConversation(history, incoming)
  const recentMessages = conversation.slice(-AGENT_RECENT_MESSAGE_LIMIT)
  writeAgentConversation(DEFAULT_AGENT_CONVERSATION_ID, scope, incoming)

  return createAgentUIStreamResponse({
    agent,
    uiMessages: messagesWithAgentSceneContext(recentMessages),
    originalMessages: recentMessages,
    generateMessageId: randomUUID,
    messageMetadata: () => ({ helix: { scene: scope } }),
    abortSignal: c.req.raw.signal,
    headers: { 'Cache-Control': 'no-store' },
    onEnd: ({ messages }) => writeAgentConversation(
      DEFAULT_AGENT_CONVERSATION_ID,
      scope,
      messages,
    ),
  })
})
