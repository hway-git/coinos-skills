import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { parseEnv } from 'node:util'

export const DEFAULT_AGENT_MODEL = 'gpt-5.6-terra'

export type AgentApiMode = 'responses' | 'chat'

export type AgentProviderConfig = {
  apiKey: string
  baseURL?: string
  apiMode: AgentApiMode
  model: string
  configured: boolean
  customBaseURL: boolean
  error: string | null
}

function localEnv() {
  try {
    return parseEnv(readFileSync(resolve(homedir(), '.helix', '.env'), 'utf8'))
  } catch {
    return {}
  }
}

function value(name: string, environment: NodeJS.ProcessEnv, file: Record<string, string | undefined>) {
  return (environment[name] || file[name] || '').trim()
}

function validateBaseURL(value: string) {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? null
      : 'HELIX_OPENAI_BASE_URL 只支持 http 或 https'
  } catch {
    return 'HELIX_OPENAI_BASE_URL 不是有效 URL'
  }
}

export function resolveAgentProviderConfig(
  environment: NodeJS.ProcessEnv = process.env,
  file: Record<string, string | undefined> = localEnv(),
): AgentProviderConfig {
  const apiKey = value('HELIX_OPENAI_API_KEY', environment, file)
    || value('OPENAI_API_KEY', environment, file)
  const baseURL = value('HELIX_OPENAI_BASE_URL', environment, file)
    || value('OPENAI_BASE_URL', environment, file)
  const requestedMode = value('HELIX_OPENAI_API_MODE', environment, file).toLowerCase()
  const modeError = requestedMode && requestedMode !== 'chat' && requestedMode !== 'responses'
    ? 'HELIX_OPENAI_API_MODE 只能是 chat 或 responses'
    : null
  const error = modeError ?? validateBaseURL(baseURL)
  const apiMode: AgentApiMode = requestedMode === 'chat' || requestedMode === 'responses'
    ? requestedMode
    : baseURL
      ? 'chat'
      : 'responses'

  return {
    apiKey,
    baseURL: baseURL || undefined,
    apiMode,
    model: value('HELIX_OPENAI_MODEL', environment, file) || DEFAULT_AGENT_MODEL,
    configured: Boolean(apiKey) && error == null,
    customBaseURL: Boolean(baseURL),
    error,
  }
}
