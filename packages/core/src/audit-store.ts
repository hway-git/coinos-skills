import { chmodSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { FreqtradeTableRow } from '@helix/contracts/freqtrade'

const DEFAULT_DATABASE_PATH = resolve(homedir(), '.helix', 'helix.sqlite')
const MAX_FIELD_LENGTH = 240

type AuditDatabaseGlobal = typeof globalThis & {
  __helixAuditDatabase?: DatabaseSync
}

function sanitize(value: string) {
  return value
    .replace(/\b127\.0\.0\.1:\d+\b/g, '[local]')
    .replace(/https?:\/\/[^\s"']+/g, '[url]')
    .replace(/Basic\s+[A-Za-z0-9+/=]+/g, 'Basic [redacted]')
    .slice(0, MAX_FIELD_LENGTH)
}

function databasePath() {
  return process.env.HELIX_DATABASE_PATH
    ? resolve(process.env.HELIX_DATABASE_PATH)
    : DEFAULT_DATABASE_PATH
}

function database() {
  const globalState = globalThis as AuditDatabaseGlobal
  if (globalState.__helixAuditDatabase) return globalState.__helixAuditDatabase

  const path = databasePath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;')
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at INTEGER NOT NULL,
      actor TEXT NOT NULL,
      event TEXT NOT NULL,
      result TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS audit_events_occurred_at
      ON audit_events (occurred_at DESC, id DESC);
  `)
  chmodSync(path, 0o600)
  globalState.__helixAuditDatabase = db
  return db
}

export function appendAuditEvent(event: string, result: string, actor = 'Helix') {
  database()
    .prepare('INSERT INTO audit_events (occurred_at, actor, event, result) VALUES (?, ?, ?, ?)')
    .run(Date.now(), sanitize(actor), sanitize(event), sanitize(result))
}

export function readAuditEvents(limit = 50): FreqtradeTableRow[] {
  const safeLimit = Math.max(1, Math.min(Math.trunc(limit), 200))
  const rows = database()
    .prepare(`
      SELECT occurred_at, actor, event, result
      FROM audit_events
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?
    `)
    .all(safeLimit) as Array<{
      occurred_at: number
      actor: string
      event: string
      result: string
    }>

  return rows.map((row) => ({
    time: new Date(row.occurred_at).toLocaleTimeString('zh-CN', { hour12: false }),
    actor: row.actor,
    event: row.event,
    result: row.result,
  }))
}
