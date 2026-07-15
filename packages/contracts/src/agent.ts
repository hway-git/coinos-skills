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

export type MarketStoryTransition = {
  scenarioId: string
  from: MarketStoryState
  to: MarketStoryState
}

export type MarketStoryEvent = AgentScope & {
  id: number
  revision: number
  eventType: 'story_created' | 'story_updated'
  changeSummary: string
  transitions: MarketStoryTransition[]
  occurredAt: number
}

export type AgentStoryResponse = {
  ok: true
  scope: AgentScope
  story: MarketStory | null
}

export type AgentStoryHistoryResponse = {
  ok: true
  scope: AgentScope
  events: MarketStoryEvent[]
}

export type AgentAnalysisTrigger = 'daily' | 'market-change'
export type AgentAnalysisRunStatus = 'running' | 'succeeded' | 'failed'

export type AgentAnalysisRun = AgentScope & {
  id: string
  trigger: AgentAnalysisTrigger
  status: AgentAnalysisRunStatus
  attempt: number
  output: string | null
  storyRevision: number | null
  error: string | null
  startedAt: number
  completedAt: number | null
}

export type AgentAnalysisHistoryResponse = {
  ok: true
  scope: AgentScope
  runs: AgentAnalysisRun[]
}

export type AgentMarketChartMarker = {
  type: 'marker' | 'expectation'
  evidenceRef: string
  text: string
  time: number
  direction: 'long' | 'short' | 'neutral'
}

export type AgentMarketChartPriceLine = {
  type: 'price-line'
  evidenceRef: string
  text: string
  price: number
}

export type AgentMarketChartResult = AgentScope & {
  candles: Array<{
    time: number
    open: number
    high: number
    low: number
    close: number
    volume: number
  }>
  annotations: Array<AgentMarketChartMarker | AgentMarketChartPriceLine>
  source: {
    name: string
    fetchedAt: number
  }
}

export const AGENT_RECENT_MESSAGE_LIMIT = 100
export const AGENT_VISIBLE_MESSAGE_LIMIT = 60
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
  memoryConfigured: boolean
  memoryCustomBaseURL: boolean
  memoryConfigurationError: string | null
}
