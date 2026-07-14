'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useChat } from '@ai-sdk/react'
import {
  AGENT_RECENT_MESSAGE_LIMIT,
  DEFAULT_AGENT_CONVERSATION_ID,
  type AgentConversationResponse,
  type AgentStoryResponse,
  type MarketStory,
} from '@helix/contracts/agent'
import { DefaultChatTransport, type UIMessage } from 'ai'
import {
  Activity,
  AlertTriangle,
  Bot,
  ClipboardList,
  Lock,
  Newspaper,
  PanelRightClose,
  PanelRightOpen,
  Send,
  ShieldCheck,
  Sparkles,
  TrendingUp,
} from 'lucide-react'
import { cn } from '@/lib/utils'

type Panel = 'agent' | 'risk' | 'execution'

const panels: Array<{ id: Panel; label: string; icon: React.ElementType }> = [
  { id: 'agent', label: '助手', icon: Bot },
  { id: 'risk', label: '风控', icon: ShieldCheck },
  { id: 'execution', label: '执行', icon: ClipboardList },
]

const suggestions = [
  { icon: TrendingUp, label: '分析当前趋势' },
  { icon: Activity, label: '检查策略信号' },
  { icon: Newspaper, label: '汇总今日事件' },
]

const daemonOrigin = (
  process.env.NEXT_PUBLIC_HELIX_DAEMON_URL?.trim() || 'http://127.0.0.1:8787'
).replace(/\/$/, '')

function messageText(message: UIMessage) {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('')
}

function HelixMessageAvatar({ active = false }: { active?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'relative mt-0.5 size-7 shrink-0 overflow-hidden rounded-md border border-border bg-primary/10',
        active && 'border-primary/40',
      )}
    >
      <img src="/helix-ai-avatar.png" alt="" className="size-full object-cover" />
      {active && <span className="absolute inset-x-1 bottom-0.5 h-px animate-pulse bg-primary/80" />}
    </div>
  )
}

function Metric({
  label,
  value,
  tone = 'neutral',
}: {
  label: string
  value: string
  tone?: 'neutral' | 'up' | 'warn' | 'down'
}) {
  return (
    <div className="rounded border border-border bg-background/35 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div
        className={cn(
          'mt-1 font-mono text-sm tabular-nums',
          tone === 'up' && 'text-up',
          tone === 'warn' && 'text-[var(--chart-3)]',
          tone === 'down' && 'text-down',
        )}
      >
        {value}
      </div>
    </div>
  )
}

function RiskPanel() {
  const rules = [
    ['账户连接', 'READ', '已接入'],
    ['策略预览', 'DRY_RUN', '可控'],
    ['审计流水', 'LOGS', '已接入'],
    ['实盘开关', 'Locked', '锁定'],
  ]

  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-3">
      <div className="grid grid-cols-2 gap-2">
        <Metric label="Risk Score" value="--" />
        <Metric label="Exposure" value="--" />
        <Metric label="Daily PnL" value="--" />
        <Metric label="Auto Trade" value="LOCKED" tone="down" />
      </div>

      <div className="mt-3 rounded border border-border bg-background/35">
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs font-medium leading-none">
          <ShieldCheck className="size-3.5 text-up" />
          Policy Gate
        </div>
        <div className="divide-y divide-border/60">
          {rules.map(([name, value, state]) => (
            <div key={name} className="grid grid-cols-[1fr_auto_auto] items-center gap-3 px-3 py-2 text-xs">
              <span>{name}</span>
              <span className="font-mono text-muted-foreground">{value}</span>
              <span className={cn('font-mono text-[11px]', state === '锁定' ? 'text-down' : 'text-muted-foreground')}>
                {state}
              </span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 flex items-start gap-2 rounded border border-[var(--chart-3)]/40 bg-[var(--chart-3)]/10 p-3 text-xs text-[var(--chart-3)]">
        <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        <p className="leading-relaxed">LIVE 交易需要显式授权、后端确认流水和审计日志；当前界面只保留锁定态。</p>
      </div>
    </div>
  )
}

function ExecutionPanel() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-3">
      <div className="rounded border border-border bg-background/35">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <div className="flex items-center gap-2 text-xs font-medium leading-none">
            <ClipboardList className="size-3.5 text-primary" />
            Execution Preview
          </div>
          <span className="inline-flex h-5 items-center rounded border border-down/30 bg-down/10 px-2 font-mono text-[10px] leading-none text-down">
            LOCKED
          </span>
        </div>
        <div className="space-y-2 px-3 py-3 text-xs">
          {[
            ['Strategy', 'Not connected'],
            ['Symbol', '--'],
            ['Intent', '--'],
            ['Mode', 'Live locked'],
            ['Preview ID', 'Missing'],
          ].map(([label, value]) => (
            <div key={label} className="flex items-center justify-between gap-3">
              <span className="text-muted-foreground">{label}</span>
              <span className="font-mono">{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Metric label="Queue" value="0" />
        <Metric label="Latency" value="--" />
        <Metric label="Slippage Guard" value="ON" tone="up" />
        <Metric label="Confirm Flow" value="Required" tone="warn" />
      </div>

      <button
        disabled
        className="mt-3 inline-flex h-10 w-full items-center justify-center gap-2 rounded border border-border bg-muted/30 text-xs font-medium leading-none text-muted-foreground"
      >
        <Lock className="size-4" />
        等待后端预览和授权
      </button>
    </div>
  )
}

function AgentPanel({
  messages,
  typing,
  story,
  error,
  input,
  setInput,
  send,
  disabled,
  scrollRef,
}: {
  messages: UIMessage[]
  typing: boolean
  story: MarketStory | null
  error: string | null
  input: string
  setInput: (value: string) => void
  send: (value: string) => void
  disabled: boolean
  scrollRef: React.RefObject<HTMLDivElement | null>
}) {
  const lastMessage = messages.at(-1)
  const waitingForFirstToken = typing && (
    lastMessage?.role !== 'assistant' || messageText(lastMessage).length === 0
  )

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      if (e.nativeEvent.isComposing || e.keyCode === 229) return
      e.preventDefault()
      send(input)
    }
  }

  return (
    <>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-4 overflow-y-auto scrollbar-thin px-4 py-4">
        {story && (
          <div className="border-l-2 border-primary/60 pl-3">
            <div className="flex items-center justify-between gap-3 font-mono text-[10px] text-muted-foreground">
              <span>{story.symbol} · {story.timeframe}</span>
              <span>REV {story.revision}</span>
            </div>
            <div className="mt-1.5 text-xs leading-relaxed text-foreground">{story.summary}</div>
            <div className="mt-2 flex items-center gap-2 font-mono text-[10px]">
              <span className="uppercase text-primary">{story.scenarios.find((scenario) => scenario.role === 'primary')?.state}</span>
              <span className="truncate text-muted-foreground">
                {story.scenarios.find((scenario) => scenario.role === 'primary')?.waitingFor}
              </span>
            </div>
          </div>
        )}
        {messages.length === 0 && !story && (
          <div className="py-6 text-center text-xs text-muted-foreground">当前作用域还没有 Market Story</div>
        )}
        {messages.map((m, index) => {
          const content = messageText(m)
          if (!content) return null
          const streaming = typing && m.role === 'assistant' && index === messages.length - 1

          if (m.role === 'user') {
            return (
              <div key={m.id} className="flex justify-end">
                <div className="max-w-[84%] whitespace-pre-wrap rounded-md rounded-tr-sm bg-primary px-3 py-2 text-[13px] leading-relaxed text-primary-foreground">
                  {content}
                </div>
              </div>
            )
          }

          return (
            <div key={m.id} className="flex min-w-0 items-start gap-2">
              <HelixMessageAvatar active={streaming} />
              <div className="min-w-0 max-w-[calc(100%_-_2.25rem)] whitespace-pre-wrap rounded-md rounded-tl-sm border border-border bg-card px-3 py-2 text-[13px] leading-relaxed text-card-foreground">
                {content}
                {streaming && (
                  <span className="ml-0.5 inline-block h-[1em] w-px translate-y-[2px] animate-pulse bg-primary" />
                )}
              </div>
            </div>
          )
        })}
        {waitingForFirstToken && (
          <div className="flex items-start gap-2">
            <HelixMessageAvatar active />
            <div className="flex h-9 items-center gap-1.5 rounded-md rounded-tl-sm border border-border bg-card px-3">
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.3s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground [animation-delay:-0.15s]" />
              <span className="size-1.5 animate-bounce rounded-full bg-muted-foreground" />
            </div>
          </div>
        )}
        {error && (
          <div className="rounded border border-down/40 bg-down/10 px-3 py-2 text-xs text-down">{error}</div>
        )}
      </div>

      <div className="flex flex-wrap gap-1.5 px-4 pb-2">
        {suggestions.map((s) => (
          <button
            key={s.label}
            onClick={() => send(s.label)}
            disabled={disabled}
            className="inline-flex h-6 items-center gap-1.5 rounded border border-border bg-card px-2.5 text-[11px] leading-none text-muted-foreground transition-colors hover:border-ring hover:text-foreground disabled:opacity-40 [&_svg]:shrink-0"
          >
            <s.icon className="size-3" />
            {s.label}
          </button>
        ))}
      </div>

      <div className="border-t border-border p-3">
        <div className="flex items-end gap-2 rounded-md border border-border bg-background/60 p-2 focus-within:border-ring">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={disabled}
            rows={1}
            placeholder="向 Helix 助手提问..."
            className="max-h-28 min-h-[24px] flex-1 resize-none bg-transparent text-[13px] text-foreground outline-none placeholder:text-muted-foreground"
          />
          <button
            onClick={() => send(input)}
            disabled={!input.trim() || typing || disabled}
            aria-label="发送"
            className="flex size-8 shrink-0 items-center justify-center rounded bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-30"
          >
            <Send className="size-4" />
          </button>
        </div>
      </div>
    </>
  )
}

export function AgentChat({
  symbol,
  timeframe,
  collapsed = false,
  onCollapsedChange,
}: {
  symbol: string
  timeframe: string
  collapsed?: boolean
  onCollapsedChange?: (collapsed: boolean) => void
}) {
  const [active, setActive] = useState<Panel>('agent')
  const [input, setInput] = useState('')
  const [story, setStory] = useState<MarketStory | null>(null)
  const [storyError, setStoryError] = useState<string | null>(null)
  const [conversationError, setConversationError] = useState<string | null>(null)
  const [conversationLoading, setConversationLoading] = useState(true)
  const scrollRef = useRef<HTMLDivElement>(null)

  const loadStory = useCallback(async (signal?: AbortSignal) => {
    const params = new URLSearchParams({ symbol, timeframe })
    const response = await fetch(`/api/agent/story?${params.toString()}`, { cache: 'no-store', signal })
    if (!response.ok) throw new Error(`Agent Story HTTP ${response.status}`)
    const payload = await response.json() as AgentStoryResponse
    setStory(payload.story)
    setStoryError(null)
  }, [symbol, timeframe])

  const transport = useMemo(() => new DefaultChatTransport({
    api: `${daemonOrigin}/api/agent/chat`,
    prepareSendMessagesRequest: ({ messages }) => ({
      body: {
        messages: messages.slice(-AGENT_RECENT_MESSAGE_LIMIT),
        symbol,
        timeframe,
      },
    }),
  }), [symbol, timeframe])

  const { messages, status, sendMessage, setMessages, error } = useChat({
    id: `helix:${DEFAULT_AGENT_CONVERSATION_ID}`,
    transport,
    onFinish: () => void loadStory(),
  })
  const typing = status === 'submitted' || status === 'streaming'

  const loadConversation = useCallback(async (signal?: AbortSignal) => {
    const response = await fetch('/api/agent/conversation', {
      cache: 'no-store',
      signal,
    })
    if (!response.ok) throw new Error(`Agent Conversation HTTP ${response.status}`)
    const payload = await response.json() as AgentConversationResponse
    setMessages(payload.messages as UIMessage[])
    setConversationError(null)
  }, [setMessages])

  useEffect(() => {
    const controller = new AbortController()
    setStory(null)
    setStoryError(null)
    void loadStory(controller.signal).catch((reason: unknown) => {
      if (reason instanceof DOMException && reason.name === 'AbortError') return
      setStoryError(reason instanceof Error ? reason.message : 'Agent Story 不可用')
    })
    return () => controller.abort()
  }, [loadStory])

  useEffect(() => {
    const controller = new AbortController()
    setConversationLoading(true)
    setConversationError(null)
    setMessages([])
    void loadConversation(controller.signal)
      .catch((reason: unknown) => {
        if (reason instanceof DOMException && reason.name === 'AbortError') return
        setConversationError(reason instanceof Error ? reason.message : 'Agent 对话不可用')
      })
      .finally(() => {
        if (!controller.signal.aborted) setConversationLoading(false)
      })
    return () => controller.abort()
  }, [loadConversation, setMessages])

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: typing ? 'auto' : 'smooth',
    })
  }, [messages, typing])

  const send = (text: string) => {
    const value = text.trim()
    if (!value || typing || conversationLoading) return
    setInput('')
    void sendMessage({ text: value })
  }

  if (collapsed) {
    return (
      <aside className="flex h-full w-full flex-col items-center overflow-hidden bg-sidebar py-2">
        <button
          type="button"
          aria-label="展开控制台"
          title="展开控制台"
          onClick={() => onCollapsedChange?.(false)}
          className="inline-flex size-8 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelRightOpen className="size-4" />
        </button>

        <div className="my-2 h-px w-7 bg-border" />

        <div className="flex flex-col gap-1">
          {panels.map((panel) => {
            const Icon = panel.icon
            const selected = active === panel.id
            return (
              <button
                key={panel.id}
                type="button"
                aria-label={panel.label}
                title={panel.label}
                onClick={() => {
                  setActive(panel.id)
                  onCollapsedChange?.(false)
                }}
                className={cn(
                  'inline-flex size-8 items-center justify-center rounded transition-colors',
                  selected ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                )}
              >
                <Icon className="size-4" />
              </button>
            )
          })}
        </div>

        <div className="mb-1 mt-auto h-1.5 w-1.5 rounded-full bg-muted-foreground" />
      </aside>
    )
  }

  return (
    <aside className="flex h-full flex-col overflow-hidden bg-sidebar">
      <header className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <div className="relative flex size-8 items-center justify-center overflow-hidden rounded bg-primary/15 ring-1 ring-primary/20">
          <img src="/helix-ai-avatar.png" alt="" className="size-8 object-cover" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 text-sm font-semibold leading-none">
            Helix 助手
            <Sparkles className="size-3 text-primary" />
          </div>
          <div className="mt-1.5 flex items-center gap-1.5 font-mono text-[10px] leading-none">
            <span className="inline-flex h-5 items-center rounded border border-up/30 bg-up/10 px-1.5 text-up">
              模拟控制
            </span>
            <span className="inline-flex h-5 items-center rounded border border-down/30 bg-down/10 px-1.5 text-down">
              实盘锁定
            </span>
          </div>
        </div>
        <button
          type="button"
          aria-label="收起控制台"
          title="收起控制台"
          onClick={() => onCollapsedChange?.(true)}
          className="inline-flex size-7 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <PanelRightClose className="size-4" />
        </button>
      </header>

      <div className="grid grid-cols-3 border-b border-border">
        {panels.map((panel) => {
          const Icon = panel.icon
          const selected = active === panel.id
          return (
            <button
              key={panel.id}
              onClick={() => setActive(panel.id)}
              className={cn(
                'inline-flex h-9 items-center justify-center gap-1.5 border-r border-border text-xs leading-none last:border-r-0 [&_svg]:shrink-0',
                selected ? 'bg-background text-foreground' : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
              )}
            >
              <Icon className="size-3.5" />
              {panel.label}
            </button>
          )
        })}
      </div>

      {active === 'agent' && (
        <AgentPanel
          messages={messages}
          typing={typing}
          story={story}
          error={error?.message ?? conversationError ?? storyError}
          input={input}
          setInput={setInput}
          send={send}
          disabled={conversationLoading || typing}
          scrollRef={scrollRef}
        />
      )}
      {active === 'risk' && <RiskPanel />}
      {active === 'execution' && <ExecutionPanel />}
    </aside>
  )
}
