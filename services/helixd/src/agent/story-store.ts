import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AgentScope, MarketScenario, MarketStory } from '@helix/contracts/agent'
import {
  agentScopeKey,
  marketStorySchema,
  marketStoryUpdateSchema,
  normalizeAgentScope,
  type MarketStoryUpdate,
} from './schemas'

const DEFAULT_DATABASE_PATH = resolve(homedir(), '.helix', 'helix.sqlite')

type AgentDatabaseGlobal = typeof globalThis & {
  __helixAgentDatabase?: DatabaseSync
}

function databasePath() {
  return process.env.HELIX_DATABASE_PATH
    ? resolve(process.env.HELIX_DATABASE_PATH)
    : DEFAULT_DATABASE_PATH
}

export function agentDatabase() {
  const globalState = globalThis as AgentDatabaseGlobal
  if (globalState.__helixAgentDatabase) return globalState.__helixAgentDatabase

  const path = databasePath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_market_stories (
      scope_key TEXT PRIMARY KEY,
      symbol TEXT NOT NULL,
      timeframe TEXT NOT NULL,
      revision INTEGER NOT NULL,
      story_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS agent_story_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scope_key TEXT NOT NULL,
      revision INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      occurred_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_story_events_scope
      ON agent_story_events (scope_key, revision DESC, id DESC);
  `)
  chmodSync(path, 0o600)
  globalState.__helixAgentDatabase = db
  return db
}

export function readMarketStory(input: AgentScope): MarketStory | null {
  const row = agentDatabase()
    .prepare('SELECT story_json FROM agent_market_stories WHERE scope_key = ?')
    .get(agentScopeKey(input)) as { story_json: string } | undefined

  if (!row) return null
  return marketStorySchema.parse(JSON.parse(row.story_json))
}

function nextScenarios(previous: MarketStory | null, update: MarketStoryUpdate, now: number): MarketScenario[] {
  const previousById = new Map(previous?.scenarios.map((scenario) => [scenario.id, scenario]) ?? [])

  return update.scenarios.map((scenario) => {
    const existing = scenario.id ? previousById.get(scenario.id) : undefined
    if (scenario.id && !existing) throw new Error(`UNKNOWN_SCENARIO_ID:${scenario.id}`)
    if (existing && existing.thesis !== scenario.thesis) {
      throw new Error(`SCENARIO_THESIS_IMMUTABLE:${scenario.id}`)
    }

    return {
      ...scenario,
      id: existing?.id ?? randomUUID(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
  })
}

export function writeMarketStory(input: AgentScope, rawUpdate: MarketStoryUpdate): MarketStory {
  const scope = normalizeAgentScope(input)
  const update = marketStoryUpdateSchema.parse(rawUpdate)
  const previous = readMarketStory(scope)
  const now = Date.now()
  const story = marketStorySchema.parse({
    id: previous?.id ?? randomUUID(),
    ...scope,
    revision: (previous?.revision ?? 0) + 1,
    summary: update.summary,
    changeSummary: update.changeSummary,
    analysisSource: update.analysisSource,
    strategyVersion: update.strategyVersion,
    scenarios: nextScenarios(previous, update, now),
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  })

  const transitions = story.scenarios.flatMap((scenario) => {
    const before = previous?.scenarios.find((item) => item.id === scenario.id)
    return before && before.state !== scenario.state
      ? [{ scenarioId: scenario.id, from: before.state, to: scenario.state }]
      : []
  })

  const db = agentDatabase()
  db.exec('BEGIN IMMEDIATE')
  try {
    db.prepare(`
      INSERT INTO agent_market_stories (
        scope_key, symbol, timeframe, revision, story_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        revision = excluded.revision,
        story_json = excluded.story_json,
        updated_at = excluded.updated_at
    `).run(
      agentScopeKey(scope),
      scope.symbol,
      scope.timeframe,
      story.revision,
      JSON.stringify(story),
      story.createdAt,
      story.updatedAt,
    )
    db.prepare(`
      INSERT INTO agent_story_events (
        scope_key, revision, event_type, payload_json, occurred_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      agentScopeKey(scope),
      story.revision,
      previous ? 'story_updated' : 'story_created',
      JSON.stringify({ changeSummary: story.changeSummary, transitions }),
      now,
    )
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }

  return story
}
