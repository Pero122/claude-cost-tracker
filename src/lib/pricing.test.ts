// src/lib/pricing.test.ts
import { describe, it, expect } from 'vitest'
import { calculateMessageCost, calculateSessionCosts } from './pricing'
import type { ParsedSession } from './types'

describe('calculateMessageCost', () => {
  it('calculates cost for opus-4-6 with all token types', () => {
    const cost = calculateMessageCost({
      model: 'claude-opus-4-6',
      timestamp: '2026-03-15T10:00:00Z',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      webSearchRequests: 0,
    })
    // input: $5 + output: $25 + cache1h: $10 + cacheRead: $0.50 = $40.50
    expect(cost).toBeCloseTo(40.50, 2)
  })

  it('calculates cost for sonnet-4-6', () => {
    const cost = calculateMessageCost({
      model: 'claude-sonnet-4-6',
      timestamp: '2026-03-15T10:00:00Z',
      inputTokens: 500_000,
      outputTokens: 100_000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 400_000,
      webSearchRequests: 0,
    })
    // input: $1.50 + output: $1.50 + cacheRead: $0.12 = $3.12
    expect(cost).toBeCloseTo(3.12, 2)
  })

  it('returns 0 for synthetic model', () => {
    const cost = calculateMessageCost({
      model: '<synthetic>',
      timestamp: '2026-03-15T10:00:00Z',
      inputTokens: 1000,
      outputTokens: 1000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
    })
    expect(cost).toBe(0)
  })

  it('returns 0 for unknown model', () => {
    const cost = calculateMessageCost({
      model: 'unknown-model-xyz',
      timestamp: '2026-03-15T10:00:00Z',
      inputTokens: 1000,
      outputTokens: 1000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
    })
    expect(cost).toBe(0)
  })

  it('includes web search cost', () => {
    const cost = calculateMessageCost({
      model: 'claude-sonnet-4-6',
      timestamp: '2026-03-15T10:00:00Z',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 5,
    })
    // 5 * $0.01 = $0.05
    expect(cost).toBeCloseTo(0.05, 2)
  })

  it('calculates 5m cache write at 1.25x rate', () => {
    const cost = calculateMessageCost({
      model: 'claude-opus-4-6',
      timestamp: '2026-03-15T10:00:00Z',
      inputTokens: 0,
      outputTokens: 0,
      cacheCreation5mTokens: 1_000_000,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
    })
    // 1.25x of $5 = $6.25
    expect(cost).toBeCloseTo(6.25, 2)
  })

  // --- 1M context premium pricing tests ---

  it('applies premium rates for opus-4-6 before GA date with >200K input', () => {
    const cost = calculateMessageCost({
      model: 'claude-opus-4-6',
      timestamp: '2026-03-12T10:00:00Z', // before GA
      inputTokens: 250_000,
      outputTokens: 10_000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
    })
    // Premium: input $10/MTok, output $37.50/MTok
    // 250K * $10/M = $2.50 + 10K * $37.50/M = $0.375 = $2.875
    expect(cost).toBeCloseTo(2.875, 3)
  })

  it('uses standard rates for opus-4-6 after GA date even with >200K input', () => {
    const cost = calculateMessageCost({
      model: 'claude-opus-4-6',
      timestamp: '2026-03-15T10:00:00Z', // after GA
      inputTokens: 250_000,
      outputTokens: 10_000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
    })
    // Standard: input $5/MTok, output $25/MTok
    // 250K * $5/M = $1.25 + 10K * $25/M = $0.25 = $1.50
    expect(cost).toBeCloseTo(1.50, 2)
  })

  it('uses standard rates for opus-4-6 before GA date with <=200K input', () => {
    const cost = calculateMessageCost({
      model: 'claude-opus-4-6',
      timestamp: '2026-03-12T10:00:00Z',
      inputTokens: 100_000,
      outputTokens: 10_000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
    })
    // Standard: 100K * $5/M = $0.50 + 10K * $25/M = $0.25 = $0.75
    expect(cost).toBeCloseTo(0.75, 2)
  })

  it('applies premium rates for sonnet-4-5 (beta) with >200K input regardless of date', () => {
    const cost = calculateMessageCost({
      model: 'claude-sonnet-4-5',
      timestamp: '2026-03-20T10:00:00Z', // after GA — but sonnet-4-5 is still beta
      inputTokens: 250_000,
      outputTokens: 10_000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
    })
    // Premium: input $6/MTok, output $22.50/MTok
    // 250K * $6/M = $1.50 + 10K * $22.50/M = $0.225 = $1.725
    expect(cost).toBeCloseTo(1.725, 3)
  })

  it('applies premium rates for sonnet-4 (beta) with >200K input regardless of date', () => {
    const cost = calculateMessageCost({
      model: 'claude-sonnet-4',
      timestamp: '2026-03-20T10:00:00Z',
      inputTokens: 250_000,
      outputTokens: 10_000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
    })
    // Premium: input $6/MTok, output $22.50/MTok
    // 250K * $6/M = $1.50 + 10K * $22.50/M = $0.225 = $1.725
    expect(cost).toBeCloseTo(1.725, 3)
  })

  it('applies premium rates for sonnet-4-6 before GA with >200K input', () => {
    const cost = calculateMessageCost({
      model: 'claude-sonnet-4-6',
      timestamp: '2026-03-12T10:00:00Z', // before GA
      inputTokens: 250_000,
      outputTokens: 10_000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
    })
    // Premium: input $6/MTok, output $22.50/MTok
    // 250K * $6/M = $1.50 + 10K * $22.50/M = $0.225 = $1.725
    expect(cost).toBeCloseTo(1.725, 3)
  })

  it('uses standard rates for sonnet-4-6 after GA even with >200K input', () => {
    const cost = calculateMessageCost({
      model: 'claude-sonnet-4-6',
      timestamp: '2026-03-15T10:00:00Z', // after GA
      inputTokens: 250_000,
      outputTokens: 10_000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 0,
      webSearchRequests: 0,
    })
    // Standard: input $3/MTok, output $15/MTok
    // 250K * $3/M = $0.75 + 10K * $15/M = $0.15 = $0.90
    expect(cost).toBeCloseTo(0.90, 2)
  })

  it('applies premium cache write rates when above 200K threshold', () => {
    const cost = calculateMessageCost({
      model: 'claude-opus-4-6',
      timestamp: '2026-03-12T10:00:00Z', // before GA
      inputTokens: 100_000,
      outputTokens: 0,
      cacheCreation5mTokens: 50_000,
      cacheCreation1hTokens: 100_000, // total = 100K + 50K + 100K = 250K > 200K
      cacheReadTokens: 0,
      webSearchRequests: 0,
    })
    // Premium: input $10/MTok, cacheWrite5m $12.50/MTok, cacheWrite1h $20/MTok
    // 100K * $10/M = $1.00 + 50K * $12.50/M = $0.625 + 100K * $20/M = $2.00 = $3.625
    expect(cost).toBeCloseTo(3.625, 3)
  })

  it('counts cache tokens toward the 200K threshold', () => {
    const cost = calculateMessageCost({
      model: 'claude-opus-4-6',
      timestamp: '2026-03-12T10:00:00Z',
      inputTokens: 50_000,
      outputTokens: 10_000,
      cacheCreation5mTokens: 0,
      cacheCreation1hTokens: 0,
      cacheReadTokens: 160_000, // 50K + 160K = 210K > 200K
      webSearchRequests: 0,
    })
    // Premium: input $10/MTok, output $37.50/MTok, cacheRead $1.0/MTok
    // 50K * $10/M = $0.50 + 10K * $37.50/M = $0.375 + 160K * $1.0/M = $0.16 = $1.035
    expect(cost).toBeCloseTo(1.035, 3)
  })
})

describe('calculateSessionCosts', () => {
  it('enriches session with costs and cumulative totals', () => {
    const session: ParsedSession = {
      id: 'test-session',
      startTime: '2026-03-13T10:00:00Z',
      endTime: '2026-03-13T11:00:00Z',
      models: ['claude-opus-4-6'],
      modelCounts: { 'claude-opus-4-6': 2 },
      version: '2.1.75',
      cwd: '/test',
      gitBranch: 'main',
      messages: [
        {
          uuid: '1', timestamp: '2026-03-13T10:00:00Z', model: 'claude-opus-4-6',
          role: 'assistant', inputTokens: 1000, outputTokens: 500,
          cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 0,
          webSearchRequests: 0, preview: 'test', fullText: '', toolCalls: [], toolResults: [],
          effort: null, hasThinking: false,
        },
        {
          uuid: '2', timestamp: '2026-03-13T10:01:00Z', model: 'claude-opus-4-6',
          role: 'assistant', inputTokens: 2000, outputTokens: 1000,
          cacheCreation5mTokens: 0, cacheCreation1hTokens: 0, cacheReadTokens: 0,
          webSearchRequests: 0, preview: 'test2', fullText: '', toolCalls: [], toolResults: [],
          effort: null, hasThinking: false,
        },
      ],
      subAgents: [],
    }

    const result = calculateSessionCosts(session)

    expect(result.messages[0].costUSD).toBeGreaterThan(0)
    expect(result.messages[1].cumulativeCostUSD).toBeGreaterThan(result.messages[0].cumulativeCostUSD)
    expect(result.totalCostUSD).toBe(result.messages[1].cumulativeCostUSD)
    expect(result.totalInputTokens).toBe(3000)
    expect(result.totalOutputTokens).toBe(1500)
    expect(result.duration).toBe(3600000) // 1 hour in ms
  })
})
