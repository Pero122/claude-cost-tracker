// src/lib/types.ts

// --- Parsed data types (what the server returns / client uses) ---

export interface ParsedMessage {
  uuid: string
  timestamp: string
  model: string
  role: 'user' | 'assistant'
  inputTokens: number
  outputTokens: number
  cacheCreation5mTokens: number
  cacheCreation1hTokens: number
  cacheReadTokens: number
  webSearchRequests: number
  preview: string
  fullText: string
  toolCalls: string[]
  toolResults: Array<{ name: string; toolInput: string; preview: string; fullResult: string; isError: boolean; agentId?: string }>
  effort: string | null
  hasThinking: boolean
}

export interface ParsedSubAgent {
  id: string
  parentSessionId: string
  agentType: string | null
  messages: ParsedMessage[]
}

export interface ParsedSession {
  id: string
  startTime: string
  endTime: string
  models: string[]
  modelCounts: Record<string, number>
  version: string
  cwd: string
  gitBranch: string
  messages: ParsedMessage[]
  subAgents: ParsedSubAgent[]
}

// --- Client-side enriched types (after cost calculation) ---

export interface Message extends ParsedMessage {
  costUSD: number
  cumulativeCostUSD: number
}

export interface SubAgent extends ParsedSubAgent {
  messages: Message[]
  totalCostUSD: number
  totalTokens: number
}

export interface Session extends ParsedSession {
  messages: Message[]
  subAgents: SubAgent[]
  totalCostUSD: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCacheReadTokens: number
  totalCacheCreation5mTokens: number
  totalCacheCreation1hTokens: number
  duration: number
}

// --- Cache analysis type ---

export interface CacheAnalysis {
  detectedTTL: '5min' | '1h' | 'mixed' | 'none'
  cacheExpirations5m: number
  cacheExpirations1h: number
  cost5min: number
  cost1h: number
  cacheCost5min: number
  cacheCost1h: number
  actualCost: number
}

export interface SessionCacheStrategies {
  detectedTTL: CacheAnalysis['detectedTTL']
  current: number
  all5min: number
  all1h: number
  hybrid: number
  expirations5m: number
  expirations1h: number
  hybridExpirations: number
}

// --- API response type ---

export interface ApiResponse {
  sessions: ParsedSession[]
}
