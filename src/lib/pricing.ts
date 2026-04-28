// src/lib/pricing.ts
import type { ParsedMessage, ParsedSession, Message, Session, SubAgent, CacheAnalysis, SessionCacheStrategies } from './types'

interface ModelPricing {
  input: number      // $ per 1M tokens
  output: number     // $ per 1M tokens
  cacheWrite5m: number
  cacheWrite1h: number
  cacheRead: number
}

const PRICING_TABLE: Record<string, ModelPricing> = {
  'claude-opus-4-7':   { input: 5,    output: 25,   cacheWrite5m: 6.25,  cacheWrite1h: 10,   cacheRead: 0.5  },
  'claude-opus-4-6':   { input: 5,    output: 25,   cacheWrite5m: 6.25,  cacheWrite1h: 10,   cacheRead: 0.5  },
  'claude-opus-4-5':   { input: 5,    output: 25,   cacheWrite5m: 6.25,  cacheWrite1h: 10,   cacheRead: 0.5  },
  'claude-opus-4-1':   { input: 15,   output: 75,   cacheWrite5m: 18.75, cacheWrite1h: 30,   cacheRead: 1.5  },
  'claude-opus-4':     { input: 15,   output: 75,   cacheWrite5m: 18.75, cacheWrite1h: 30,   cacheRead: 1.5  },
  'claude-sonnet-4-6': { input: 3,    output: 15,   cacheWrite5m: 3.75,  cacheWrite1h: 6,    cacheRead: 0.3  },
  'claude-sonnet-4-5': { input: 3,    output: 15,   cacheWrite5m: 3.75,  cacheWrite1h: 6,    cacheRead: 0.3  },
  'claude-sonnet-4':   { input: 3,    output: 15,   cacheWrite5m: 3.75,  cacheWrite1h: 6,    cacheRead: 0.3  },
  'claude-haiku-4-5':  { input: 1,    output: 5,    cacheWrite5m: 1.25,  cacheWrite1h: 2,    cacheRead: 0.1  },
  'claude-haiku-3-5':  { input: 0.8,  output: 4,    cacheWrite5m: 1,     cacheWrite1h: 1.6,  cacheRead: 0.08 },
  'claude-haiku-3':    { input: 0.25, output: 1.25, cacheWrite5m: 0.3,   cacheWrite1h: 0.5,  cacheRead: 0.03 },
}

// 1M context premium rates: 2x input, 1.5x output, 2x cache rates
const PREMIUM_PRICING_TABLE: Record<string, ModelPricing> = {
  'claude-opus-4-7':   { input: 10,   output: 37.50, cacheWrite5m: 12.50, cacheWrite1h: 20,   cacheRead: 1.0  },
  'claude-opus-4-6':   { input: 10,   output: 37.50, cacheWrite5m: 12.50, cacheWrite1h: 20,   cacheRead: 1.0  },
  'claude-sonnet-4-6': { input: 6,    output: 22.50, cacheWrite5m: 7.50,  cacheWrite1h: 12,   cacheRead: 0.6  },
  'claude-sonnet-4-5': { input: 6,    output: 22.50, cacheWrite5m: 7.50,  cacheWrite1h: 12,   cacheRead: 0.6  },
  'claude-sonnet-4':   { input: 6,    output: 22.50, cacheWrite5m: 7.50,  cacheWrite1h: 12,   cacheRead: 0.6  },
}

// Models where premium was removed at GA (2026-03-13)
const GA_DATE = '2026-03-13'
const GA_MODELS = new Set(['claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6'])
// Models that still have 1M premium (still in beta)
const BETA_1M_MODELS = new Set(['claude-sonnet-4-5', 'claude-sonnet-4'])

const INPUT_THRESHOLD = 200_000

const WEB_SEARCH_COST = 0.01 // $0.01 per search

interface CostInput {
  model: string
  timestamp: string
  inputTokens: number
  outputTokens: number
  cacheCreation5mTokens: number
  cacheCreation1hTokens: number
  cacheReadTokens: number
  webSearchRequests: number
}

function normalizeModelId(model: string): string {
  return model.replace(/-\d{8}$/, '')
}

export function getPricing(model: string, timestamp: string, totalInputTokens: number): ModelPricing | null {
  const normalized = normalizeModelId(model)
  const standard = PRICING_TABLE[normalized] ?? PRICING_TABLE[model]
  if (!standard) return null

  const premium = PREMIUM_PRICING_TABLE[normalized] ?? PREMIUM_PRICING_TABLE[model]
  if (!premium || totalInputTokens <= INPUT_THRESHOLD) return standard

  const dateStr = timestamp.slice(0, 10)

  // GA models: premium only before GA date
  if (GA_MODELS.has(normalized)) {
    return dateStr < GA_DATE ? premium : standard
  }

  // Beta 1M models: premium always applies above threshold
  if (BETA_1M_MODELS.has(normalized)) {
    return premium
  }

  return standard
}

export function calculateMessageCost(input: CostInput): number {
  const totalInput = input.inputTokens + input.cacheReadTokens +
    input.cacheCreation5mTokens + input.cacheCreation1hTokens

  const pricing = getPricing(input.model, input.timestamp, totalInput)
  if (!pricing) {
    if (input.model !== '<synthetic>') {
      console.warn(`Unknown model: ${input.model} — defaulting to $0 cost`)
    }
    return 0
  }

  return (
    (input.inputTokens * pricing.input / 1_000_000) +
    (input.outputTokens * pricing.output / 1_000_000) +
    (input.cacheCreation5mTokens * pricing.cacheWrite5m / 1_000_000) +
    (input.cacheCreation1hTokens * pricing.cacheWrite1h / 1_000_000) +
    (input.cacheReadTokens * pricing.cacheRead / 1_000_000) +
    (input.webSearchRequests * WEB_SEARCH_COST)
  )
}

function enrichMessages(messages: ParsedMessage[]): Message[] {
  let cumulative = 0
  return messages.map(msg => {
    const cost = msg.role === 'assistant' ? calculateMessageCost({ ...msg, timestamp: msg.timestamp }) : 0
    cumulative += cost
    return { ...msg, costUSD: cost, cumulativeCostUSD: cumulative }
  })
}

export function calculateSessionCosts(parsed: ParsedSession): Session {
  const messages = enrichMessages(parsed.messages)

  const subAgents: SubAgent[] = parsed.subAgents.map(sa => {
    const saMessages = enrichMessages(sa.messages)
    const totalCost = saMessages.reduce((sum, m) => sum + m.costUSD, 0)
    const totalTokens = saMessages.reduce(
      (sum, m) => sum + m.inputTokens + m.outputTokens + m.cacheReadTokens +
        m.cacheCreation5mTokens + m.cacheCreation1hTokens, 0
    )
    return { ...sa, messages: saMessages, totalCostUSD: totalCost, totalTokens }
  })

  const allMessages = [...messages, ...subAgents.flatMap(sa => sa.messages)]

  const totalCostUSD = allMessages.reduce((sum, m) => sum + m.costUSD, 0)
  const totalInputTokens = allMessages.reduce((sum, m) => sum + m.inputTokens, 0)
  const totalOutputTokens = allMessages.reduce((sum, m) => sum + m.outputTokens, 0)
  const totalCacheReadTokens = allMessages.reduce((sum, m) => sum + m.cacheReadTokens, 0)
  const totalCacheCreation5mTokens = allMessages.reduce((sum, m) => sum + m.cacheCreation5mTokens, 0)
  const totalCacheCreation1hTokens = allMessages.reduce((sum, m) => sum + m.cacheCreation1hTokens, 0)

  const start = new Date(parsed.startTime).getTime()
  const end = new Date(parsed.endTime).getTime()
  const duration = (isNaN(start) || isNaN(end)) ? 0 : end - start

  return {
    ...parsed,
    messages,
    subAgents,
    totalCostUSD,
    totalInputTokens,
    totalOutputTokens,
    totalCacheReadTokens,
    totalCacheCreation5mTokens,
    totalCacheCreation1hTokens,
    duration,
  }
}

export function getModelPricing(model: string): ModelPricing | null {
  return PRICING_TABLE[model] ?? null
}

// --- Cache analysis ---

const FIVE_MIN_MS = 5 * 60 * 1000
const ONE_HOUR_MS = 60 * 60 * 1000

interface CacheScenarioResult {
  totalCost: number
  cacheCost: number
  expirations: number
}

function simulateCacheScenario(
  messages: Message[],
  ttlMs: number,
  ttlType: '5m' | '1h',
): CacheScenarioResult {
  let totalCost = 0
  let cacheCost = 0
  let expirations = 0
  let lastAssistantTime: number | null = null

  for (const msg of messages) {
    if (msg.role !== 'assistant') continue

    const totalInput = msg.inputTokens + msg.cacheReadTokens +
      msg.cacheCreation5mTokens + msg.cacheCreation1hTokens
    const pricing = getPricing(msg.model, msg.timestamp, totalInput)
    if (!pricing) continue

    // All tokens that participate in caching (were either written or read from cache)
    const cacheableTokens = msg.cacheCreation5mTokens + msg.cacheCreation1hTokens + msg.cacheReadTokens
    const msgTime = new Date(msg.timestamp).getTime()

    let cacheTokenCost = 0
    if (cacheableTokens > 0) {
      if (lastAssistantTime === null || (msgTime - lastAssistantTime) > ttlMs) {
        // Cache expired or first message — cache write
        const writeRate = ttlType === '5m' ? pricing.cacheWrite5m : pricing.cacheWrite1h
        cacheTokenCost = cacheableTokens * writeRate / 1_000_000
        if (lastAssistantTime !== null) expirations++
      } else {
        // Cache still valid — cache read
        cacheTokenCost = cacheableTokens * pricing.cacheRead / 1_000_000
      }
    }

    const otherCost =
      (msg.inputTokens * pricing.input / 1_000_000) +
      (msg.outputTokens * pricing.output / 1_000_000) +
      (msg.webSearchRequests * WEB_SEARCH_COST)

    cacheCost += cacheTokenCost
    totalCost += cacheTokenCost + otherCost
    lastAssistantTime = msgTime
  }

  return { totalCost, cacheCost, expirations }
}

export function analyzeCacheCost(session: Session): CacheAnalysis {
  // Detect current TTL from actual data
  const allMsgs = [...session.messages, ...session.subAgents.flatMap(sa => sa.messages)]
  const has5m = allMsgs.some(m => m.cacheCreation5mTokens > 0)
  const has1h = allMsgs.some(m => m.cacheCreation1hTokens > 0)
  const hasAnyCache = has5m || has1h || allMsgs.some(m => m.cacheReadTokens > 0)
  const detectedTTL: CacheAnalysis['detectedTTL'] = !hasAnyCache ? 'none'
    : (has5m && has1h) ? 'mixed'
    : has1h ? '1h'
    : '5min'

  // Simulate main session under both TTLs
  const main5m = simulateCacheScenario(session.messages, FIVE_MIN_MS, '5m')
  const main1h = simulateCacheScenario(session.messages, ONE_HOUR_MS, '1h')

  // Simulate each subagent independently (separate cache contexts)
  let sa5mCost = 0, sa1hCost = 0, sa5mCache = 0, sa1hCache = 0
  let sa5mExp = 0, sa1hExp = 0
  for (const sa of session.subAgents) {
    const s5m = simulateCacheScenario(sa.messages, FIVE_MIN_MS, '5m')
    const s1h = simulateCacheScenario(sa.messages, ONE_HOUR_MS, '1h')
    sa5mCost += s5m.totalCost
    sa1hCost += s1h.totalCost
    sa5mCache += s5m.cacheCost
    sa1hCache += s1h.cacheCost
    sa5mExp += s5m.expirations
    sa1hExp += s1h.expirations
  }

  return {
    detectedTTL,
    cacheExpirations5m: main5m.expirations + sa5mExp,
    cacheExpirations1h: main1h.expirations + sa1hExp,
    cost5min: main5m.totalCost + sa5mCost,
    cost1h: main1h.totalCost + sa1hCost,
    cacheCost5min: main5m.cacheCost + sa5mCache,
    cacheCost1h: main1h.cacheCost + sa1hCache,
    actualCost: session.totalCostUSD,
  }
}

export function analyzeSessionStrategies(session: Session): SessionCacheStrategies {
  const allMsgs = [...session.messages, ...session.subAgents.flatMap(sa => sa.messages)]
  const has5m = allMsgs.some(m => m.cacheCreation5mTokens > 0)
  const has1h = allMsgs.some(m => m.cacheCreation1hTokens > 0)
  const hasAnyCache = has5m || has1h || allMsgs.some(m => m.cacheReadTokens > 0)
  const detectedTTL: CacheAnalysis['detectedTTL'] = !hasAnyCache ? 'none'
    : (has5m && has1h) ? 'mixed' : has1h ? '1h' : '5min'

  // All 5-min strategy
  const main5m = simulateCacheScenario(session.messages, FIVE_MIN_MS, '5m')
  let sa5mCost = 0, sa5mExp = 0
  for (const sa of session.subAgents) {
    const r = simulateCacheScenario(sa.messages, FIVE_MIN_MS, '5m')
    sa5mCost += r.totalCost; sa5mExp += r.expirations
  }

  // All 1-hour strategy
  const main1h = simulateCacheScenario(session.messages, ONE_HOUR_MS, '1h')
  let sa1hCost = 0, sa1hExp = 0
  for (const sa of session.subAgents) {
    const r = simulateCacheScenario(sa.messages, ONE_HOUR_MS, '1h')
    sa1hCost += r.totalCost; sa1hExp += r.expirations
  }

  // Hybrid: 1h main, 5m subagents
  return {
    detectedTTL,
    current: session.totalCostUSD,
    all5min: main5m.totalCost + sa5mCost,
    all1h: main1h.totalCost + sa1hCost,
    hybrid: main1h.totalCost + sa5mCost, // 1h main + 5m agents
    expirations5m: main5m.expirations + sa5mExp,
    expirations1h: main1h.expirations + sa1hExp,
    hybridExpirations: main1h.expirations + sa5mExp,
  }
}

export const USD_TO_EUR = 0.92
