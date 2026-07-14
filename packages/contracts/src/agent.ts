export type AgentScope = {
  symbol: string
  timeframe: string
}

export type MarketStoryState = 'watching' | 'armed' | 'confirmed' | 'rejected' | 'expired'
export type MarketScenarioRole = 'primary' | 'alternative'

export type MarketScenario = {
  id: string
  role: MarketScenarioRole
  thesis: string
  expectation: string
  state: MarketStoryState
  waitingFor: string
  invalidation: string
  evidenceRefs: string[]
  createdAt: number
  updatedAt: number
}

export type MarketStory = AgentScope & {
  id: string
  revision: number
  summary: string
  changeSummary: string
  analysisSource: string
  strategyVersion: string
  scenarios: MarketScenario[]
  createdAt: number
  updatedAt: number
}

export type AgentStoryResponse = {
  ok: true
  scope: AgentScope
  story: MarketStory | null
}

export const AGENT_RECENT_MESSAGE_LIMIT = 100
export const DEFAULT_AGENT_CONVERSATION_ID = 'main'

export type AgentConversationMessage = {
  id: string
  role: 'system' | 'user' | 'assistant'
  metadata?: unknown
  parts: unknown[]
}

export type AgentConversationResponse = {
  ok: true
  conversationId: string
  messages: AgentConversationMessage[]
}

export type AgentStatusResponse = {
  ok: true
  service: 'helix-agent'
  model: string
  modelConfigured: boolean
  apiMode: 'responses' | 'chat'
  customBaseURL: boolean
  configurationError: string | null
}
