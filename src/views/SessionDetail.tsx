import { useState, useMemo, useEffect, useRef } from 'react'
import type { Session, SubAgent, Message } from '../lib/types'
import { navigate } from '../lib/router'
import { formatDuration, formatTokens, formatCost, formatCostShort, shortenPath } from '../lib/format'
import { analyzeCacheCost } from '../lib/pricing'

interface Props {
  session: Session
  onBack: () => void
  convertCurrency: (usd: number) => number
  currencySymbol: string
  initialAgentId?: string
}

function formatTime(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function hasAny5mCache(session: Session): boolean {
  const allMessages = [...session.messages, ...session.subAgents.flatMap(sa => sa.messages)]
  return allMessages.some(m => m.cacheCreation5mTokens > 0)
}

// Aggregate tool stats from messages
function aggregateToolStats(messages: Message[]): Array<{ name: string; count: number; errors: number }> {
  const map = new Map<string, { count: number; errors: number }>()
  for (const msg of messages) {
    for (const tc of msg.toolCalls) {
      const entry = map.get(tc) || { count: 0, errors: 0 }
      entry.count++
      map.set(tc, entry)
    }
    for (const tr of msg.toolResults) {
      if (tr.isError) {
        const entry = map.get(tr.name) || { count: 0, errors: 0 }
        entry.errors++
        map.set(tr.name, entry)
      }
    }
  }
  return [...map.entries()]
    .map(([name, stats]) => ({ name, ...stats }))
    .sort((a, b) => b.count - a.count)
}

// Build ordinal mapping: Nth Agent tool call → Nth sub-agent by startTime
function buildAgentOrdinalMap(messages: Message[], subAgents: SubAgent[]): Map<string, string> {
  const map = new Map<string, string>()
  const claimed = new Set<number>()

  const agentCalls: Array<{ key: string; timestamp: string }> = []
  for (let mi = 0; mi < messages.length; mi++) {
    const msg = messages[mi]
    for (let ti = 0; ti < msg.toolCalls.length; ti++) {
      if (msg.toolCalls[ti] === 'Agent') {
        agentCalls.push({ key: `${mi}-${ti}`, timestamp: msg.timestamp })
      }
    }
  }

  for (const call of agentCalls) {
    let bestIdx = -1
    let bestDelta = Infinity
    for (let si = 0; si < subAgents.length; si++) {
      if (claimed.has(si)) continue
      const saStart = subAgents[si].messages[0]?.timestamp || ''
      if (!saStart) continue
      const delta = Math.abs(new Date(saStart).getTime() - new Date(call.timestamp).getTime())
      if (delta < bestDelta) {
        bestDelta = delta
        bestIdx = si
      }
    }
    if (bestIdx >= 0) {
      map.set(call.key, subAgents[bestIdx].id)
      claimed.add(bestIdx)
    }
  }

  return map
}

interface MessageTableProps {
  messages: Message[]
  convertCurrency: (usd: number) => number
  currencySymbol: string
  show5mCache: boolean
  costGroupSize: number
  costThreshold: number | null
  subAgents?: SubAgent[]
  onAgentBadgeClick?: (subAgentId: string, rowIndex: number) => void
}

type MsgSortKey = 'input' | 'output' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h' | 'cost' | 'cumulative'
type SortDir = 'asc' | 'desc'

function MessageTable({ messages, convertCurrency, currencySymbol, show5mCache, costGroupSize, costThreshold, subAgents, onAgentBadgeClick }: MessageTableProps) {
  const agentOrdinalMap = useMemo(
    () => subAgents ? buildAgentOrdinalMap(messages, subAgents) : new Map<string, string>(),
    [messages, subAgents]
  )
  const subAgentCostMap = useMemo(() => {
    const m = new Map<string, number>()
    if (subAgents) for (const sa of subAgents) m.set(sa.id, sa.totalCostUSD)
    return m
  }, [subAgents])
  const [sortKey, setSortKey] = useState<MsgSortKey | null>(null)
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set())

  function handleSort(key: MsgSortKey) {
    if (sortKey === key) {
      if (sortDir === 'desc') setSortDir('asc')
      else { setSortKey(null); setSortDir('desc') }
    } else {
      setSortKey(key)
      setSortDir('desc')
    }
  }

  function toggleExpand(uuid: string, e: React.MouseEvent) {
    // Don't expand when clicking agent badges or links
    if ((e.target as HTMLElement).closest('.tool-badge-agent')) return
    setExpandedMessages(prev => {
      const next = new Set(prev)
      if (next.has(uuid)) next.delete(uuid)
      else next.add(uuid)
      return next
    })
  }

  const sortIndicator = (key: MsgSortKey) => sortKey === key ? (sortDir === 'asc' ? ' ▲' : ' ▼') : ''

  const indexed = useMemo(() => messages.map((msg, i) => ({ msg, origIdx: i })), [messages])

  const sorted = useMemo(() => {
    if (!sortKey) return indexed
    const mul = sortDir === 'asc' ? 1 : -1
    return [...indexed].sort((a, b) => {
      const am = a.msg, bm = b.msg
      switch (sortKey) {
        case 'input': return mul * (am.inputTokens - bm.inputTokens)
        case 'output': return mul * (am.outputTokens - bm.outputTokens)
        case 'cacheRead': return mul * (am.cacheReadTokens - bm.cacheReadTokens)
        case 'cacheWrite5m': return mul * (am.cacheCreation5mTokens - bm.cacheCreation5mTokens)
        case 'cacheWrite1h': return mul * (am.cacheCreation1hTokens - bm.cacheCreation1hTokens)
        case 'cost': return mul * (am.costUSD - bm.costUSD)
        case 'cumulative': return mul * (am.cumulativeCostUSD - bm.cumulativeCostUSD)
        default: return 0
      }
    })
  }, [indexed, sortKey, sortDir])

  const rows: Array<{ type: 'message'; msg: Message; origIdx: number } | { type: 'divider'; amount: number }> = []
  let nextThreshold = costGroupSize
  let cumulative = 0

  for (const { msg, origIdx } of sorted) {
    if (!sortKey) {
      cumulative += convertCurrency(msg.costUSD)
      while (nextThreshold > 0 && cumulative >= nextThreshold) {
        rows.push({ type: 'divider', amount: nextThreshold })
        nextThreshold += costGroupSize
      }
    }
    rows.push({ type: 'message', msg, origIdx })
  }

  const colCount = show5mCache ? 10 : 9

  return (
    <table>
      <thead>
        <tr>
          <th>#</th>
          <th>Time</th>
          <th>Role</th>
          <th>Preview</th>
          <th className="num" onClick={() => handleSort('input')}>Input{sortIndicator('input')}</th>
          <th className="num" onClick={() => handleSort('output')}>Output{sortIndicator('output')}</th>
          <th className="num" onClick={() => handleSort('cacheRead')}>Cache R{sortIndicator('cacheRead')}</th>
          {show5mCache && <th className="num" onClick={() => handleSort('cacheWrite5m')}>Cache W (5m){sortIndicator('cacheWrite5m')}</th>}
          <th className="num" onClick={() => handleSort('cacheWrite1h')}>Cache W (1h){sortIndicator('cacheWrite1h')}</th>
          <th className="num" onClick={() => handleSort('cost')}>Cost{sortIndicator('cost')}</th>
          <th className="num" onClick={() => handleSort('cumulative')}>Cumulative{sortIndicator('cumulative')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row, idx) => {
          if (row.type === 'divider') {
            return (
              <tr key={`div-${idx}`}>
                <td colSpan={colCount + 1} className="cost-divider">
                  ——— {formatCostShort(row.amount, currencySymbol)} spent ———
                </td>
              </tr>
            )
          }
          const { msg, origIdx } = row
          const isUser = msg.role === 'user'
          const isExpensive = !isUser && costThreshold != null && convertCurrency(msg.costUSD) > costThreshold
          const isExpanded = expandedMessages.has(msg.uuid)
          const hasFullText = (msg.fullText && msg.fullText.length > msg.preview.length) ||
            msg.toolResults.some(tr => tr.fullResult && tr.fullResult.length > 80)
          return (
            <tr
              key={msg.uuid || `msg-${idx}`}
              className={`${isUser ? 'user-row' : ''}${isExpensive ? ' expensive-row' : ''}${hasFullText ? ' expandable-row' : ''}`}
              data-msg-idx={origIdx}
              onClick={hasFullText ? (e) => toggleExpand(msg.uuid, e) : undefined}
            >
              <td className="muted">{origIdx + 1}</td>
              <td className="muted">{formatTime(msg.timestamp)}</td>
              <td>
                {msg.role}
                {!isUser && msg.effort && <span className="effort-badge" title={`Effort: ${msg.effort}`}>{msg.effort}</span>}
                {!isUser && msg.hasThinking && <span className="thinking-indicator" title="Extended thinking used">T</span>}
              </td>
              <td title={isExpanded ? undefined : msg.preview} style={{ maxWidth: '400px' }}>
                {isExpanded ? (
                  <div className="expanded-content">
                    {msg.fullText && <div className="expanded-text">{msg.fullText}</div>}
                    {msg.toolResults.length > 0 && (
                      <div className="expanded-tools">
                        {msg.toolResults.map((tr, tri) => (
                          <div key={tri} className="expanded-tool-result">
                            <div className="expanded-tool-header">
                              <span style={{ color: tr.isError ? 'var(--red)' : 'var(--accent)' }}>{tr.name}</span>
                              {tr.isError && <span style={{ color: 'var(--red)', marginLeft: 4 }}>ERROR</span>}
                              {tr.toolInput && <span className="expanded-tool-input">{tr.toolInput}</span>}
                            </div>
                            {tr.fullResult && <pre className="expanded-text">{tr.fullResult}</pre>}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {msg.preview}
                    {msg.toolCalls.length > 0 && (
                      <span style={{ marginLeft: msg.preview ? 6 : 0 }}>
                        {msg.toolCalls.map((t, ti) => {
                          const isAgent = t === 'Agent'
                          const toolResult = msg.toolResults[ti]
                          const mappedAgentId = agentOrdinalMap.get(`${origIdx}-${ti}`)
                          const agentCost = mappedAgentId ? subAgentCostMap.get(mappedAgentId) : undefined
                          return (
                            <span key={ti} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
                              <span
                                className={`tool-badge${isAgent && mappedAgentId ? ' tool-badge-agent' : ''}${toolResult?.isError ? ' tool-badge-error' : ''}`}
                                onClick={isAgent && mappedAgentId && onAgentBadgeClick ? (e) => { e.stopPropagation(); onAgentBadgeClick(mappedAgentId, origIdx) } : undefined}
                              >
                                {t}
                              </span>
                              {isAgent && agentCost !== undefined && agentCost > 0 && (
                                <span className="agent-cost-inline">{formatCostShort(convertCurrency(agentCost), currencySymbol)}</span>
                              )}
                            </span>
                          )
                        })}
                      </span>
                    )}
                  </div>
                )}
                {!isExpanded && msg.toolResults && msg.toolResults.length > 0 && (
                  <div style={{ marginTop: 2, fontSize: 11, color: 'var(--text-muted)', fontFamily: "'SF Mono', 'Fira Code', monospace", whiteSpace: 'normal' }}>
                    {msg.toolResults.map((tr, tri) => (
                      <div key={tri} style={{ opacity: 0.7 }}>
                        <span style={{ color: tr.isError ? 'var(--red)' : 'var(--accent)' }}>{tr.name}</span>
                        {tr.isError && <span style={{ color: 'var(--red)', marginLeft: 4 }}>ERROR</span>}
                        {tr.toolInput && <span style={{ marginLeft: 4, color: 'var(--yellow)' }}>{tr.toolInput.slice(0, 60)}{tr.toolInput.length > 60 ? '...' : ''}</span>}
                        {tr.preview && <span style={{ marginLeft: 6 }}>→ {tr.preview.slice(0, 80)}{tr.preview.length > 80 ? '...' : ''}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </td>
              {isUser ? (
                <td colSpan={show5mCache ? 7 : 6}></td>
              ) : (
                <>
                  <td className="num">{formatTokens(msg.inputTokens)}</td>
                  <td className="num">{formatTokens(msg.outputTokens)}</td>
                  <td className="num">{msg.cacheReadTokens > 0 ? formatTokens(msg.cacheReadTokens) : '-'}</td>
                  {show5mCache && <td className="num">{msg.cacheCreation5mTokens > 0 ? formatTokens(msg.cacheCreation5mTokens) : '-'}</td>}
                  <td className="num">{msg.cacheCreation1hTokens > 0 ? formatTokens(msg.cacheCreation1hTokens) : '-'}</td>
                  <td className="num cost">{formatCost(convertCurrency(msg.costUSD), currencySymbol)}</td>
                  <td className="num">{formatCostShort(convertCurrency(msg.cumulativeCostUSD), currencySymbol)}</td>
                </>
              )}
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}

export function SessionDetail({ session, onBack, convertCurrency, currencySymbol, initialAgentId }: Props) {
  const [expandedAgents, setExpandedAgents] = useState<Set<string>>(() => {
    return initialAgentId ? new Set([initialAgentId]) : new Set()
  })
  const [costGroupSize, setCostGroupSize] = useState(5)
  const [costThreshold, setCostThreshold] = useState<number | null>(() => {
    const saved = localStorage.getItem('cost-tracker-msg-threshold')
    return saved ? parseFloat(saved) : null
  })
  const [sourceRowIndex, setSourceRowIndex] = useState<number | null>(null)
  const agentPanelRefs = useRef<Map<string, HTMLDivElement>>(new Map())

  const show5mCache = useMemo(() => hasAny5mCache(session), [session])

  // Cache analysis
  const cacheAnalysis = useMemo(() => analyzeCacheCost(session), [session])

  // Cost split
  const agentCostUSD = useMemo(() => session.subAgents.reduce((sum, sa) => sum + sa.totalCostUSD, 0), [session])
  const mainCostUSD = session.totalCostUSD - agentCostUSD
  const hasAgents = session.subAgents.length > 0

  // Model display with percentages
  const modelDisplay = useMemo(() => {
    const counts = session.modelCounts || {}
    const total = Object.values(counts).reduce((s, n) => s + n, 0)
    if (total === 0) return session.models.map(m => m.replace(/^claude-/, '')).join(', ')
    return Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([m, count]) => `${m.replace(/^claude-/, '')} (${Math.round(count / total * 100)}%)`)
      .join(', ')
  }, [session])

  // Per-session tool summary
  const allSessionMessages = useMemo(() => [...session.messages, ...session.subAgents.flatMap(sa => sa.messages)], [session])
  const toolStats = useMemo(() => aggregateToolStats(allSessionMessages), [allSessionMessages])

  // Scroll to agent panel on initial load
  useEffect(() => {
    if (initialAgentId) {
      const el = agentPanelRefs.current.get(initialAgentId)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [initialAgentId])

  function toggleAgent(id: string) {
    setExpandedAgents(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function handleAgentBadgeClick(agentId: string, rowIndex: number) {
    setSourceRowIndex(rowIndex)
    setExpandedAgents(prev => new Set(prev).add(agentId))
    navigate({ view: 'session', id: session.id, agentId })
    setTimeout(() => {
      const el = agentPanelRefs.current.get(agentId)
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 50)
  }

  function handleBackToMessage() {
    if (sourceRowIndex === null) return
    const row = document.querySelector(`[data-msg-idx="${sourceRowIndex}"]`)
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'center' })
    setSourceRowIndex(null)
  }

  function handleExportSession() {
    const data = {
      id: session.id,
      startTime: session.startTime,
      endTime: session.endTime,
      models: session.models,
      modelCounts: session.modelCounts,
      cwd: session.cwd,
      gitBranch: session.gitBranch,
      version: session.version,
      duration: session.duration,
      totalCostUSD: session.totalCostUSD,
      totalInputTokens: session.totalInputTokens,
      totalOutputTokens: session.totalOutputTokens,
      totalCacheReadTokens: session.totalCacheReadTokens,
      totalCacheCreation5mTokens: session.totalCacheCreation5mTokens,
      totalCacheCreation1hTokens: session.totalCacheCreation1hTokens,
      cacheAnalysis,
      messages: session.messages,
      subAgents: session.subAgents.map(sa => ({
        id: sa.id,
        agentType: sa.agentType,
        totalCostUSD: sa.totalCostUSD,
        totalTokens: sa.totalTokens,
        messages: sa.messages,
      })),
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const dateStr = new Date(session.startTime).toISOString().slice(0, 10)
    a.download = `session-${session.id.slice(0, 8)}-${dateStr}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function handleThresholdChange(val: string) {
    if (val === '' || val === null) {
      setCostThreshold(null)
      localStorage.removeItem('cost-tracker-msg-threshold')
    } else {
      const n = parseFloat(val)
      if (!isNaN(n) && n >= 0) {
        setCostThreshold(n)
        localStorage.setItem('cost-tracker-msg-threshold', String(n))
      }
    }
  }

  const savings5m = cacheAnalysis.cost1h - cacheAnalysis.cost5min
  const savings1h = cacheAnalysis.cost5min - cacheAnalysis.cost1h
  const cheaperTTL = savings1h > 0.001 ? '1h' : savings5m > 0.001 ? '5min' : 'same'

  return (
    <div>
      <button className="back-button" onClick={onBack}>&larr; Back to sessions</button>

      <div className="session-header">
        <div>
          <div className="label">Date</div>
          <div className="value">{new Date(session.startTime).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</div>
        </div>
        <div>
          <div className="label">Model(s)</div>
          <div className="value">{modelDisplay}</div>
        </div>
        <div>
          <div className="label">Working Dir</div>
          <div className="value" title={session.cwd}>{shortenPath(session.cwd)}</div>
        </div>
        <div>
          <div className="label">Git Branch</div>
          <div className="value">{session.gitBranch || '-'}</div>
        </div>
        <div>
          <div className="label">Duration</div>
          <div className="value">{formatDuration(session.duration)}</div>
        </div>
        {hasAgents ? (
          <>
            <div>
              <div className="label">Main Cost</div>
              <div className="value cost">{formatCostShort(convertCurrency(mainCostUSD), currencySymbol)}</div>
            </div>
            <div>
              <div className="label">Agent Cost</div>
              <div className="value cost">{formatCostShort(convertCurrency(agentCostUSD), currencySymbol)}</div>
            </div>
            <div>
              <div className="label">Total Cost</div>
              <div className="value cost">{formatCostShort(convertCurrency(session.totalCostUSD), currencySymbol)}</div>
            </div>
          </>
        ) : (
          <div>
            <div className="label">Total Cost</div>
            <div className="value cost">{formatCostShort(convertCurrency(session.totalCostUSD), currencySymbol)}</div>
          </div>
        )}
        <div>
          <div className="label">Version</div>
          <div className="value">{session.version || '-'}</div>
        </div>
      </div>

      {/* Cache analysis card */}
      {cacheAnalysis.detectedTTL !== 'none' && (
        <div className="cache-analysis-card">
          <div className="cache-analysis-header">
            <strong>Cache Analysis</strong>
            <span className="cache-detected-badge">
              {cacheAnalysis.detectedTTL === '5min' ? '5-min' : cacheAnalysis.detectedTTL === '1h' ? '1-hour' : 'mixed'} cache (current)
            </span>
          </div>
          <div className="cache-analysis-body">
            <table className="cache-comparison-table">
              <thead>
                <tr>
                  <th></th>
                  <th className={`num${cacheAnalysis.detectedTTL === '5min' ? ' cache-current' : ''}`}>
                    5-min cache {cacheAnalysis.detectedTTL === '5min' && '●'}
                  </th>
                  <th className={`num${cacheAnalysis.detectedTTL === '1h' ? ' cache-current' : ''}`}>
                    1-hour cache {cacheAnalysis.detectedTTL === '1h' && '●'}
                  </th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="muted">Cache expirations</td>
                  <td className="num">{cacheAnalysis.cacheExpirations5m}</td>
                  <td className="num">{cacheAnalysis.cacheExpirations1h}</td>
                </tr>
                <tr>
                  <td className="muted">Cache cost</td>
                  <td className="num">{formatCostShort(convertCurrency(cacheAnalysis.cacheCost5min), currencySymbol)}</td>
                  <td className="num">{formatCostShort(convertCurrency(cacheAnalysis.cacheCost1h), currencySymbol)}</td>
                </tr>
                <tr>
                  <td className="muted">Total cost</td>
                  <td className={`num${cheaperTTL === '5min' ? ' cost' : ''}`}>
                    {formatCostShort(convertCurrency(cacheAnalysis.cost5min), currencySymbol)}
                  </td>
                  <td className={`num${cheaperTTL === '1h' ? ' cost' : ''}`}>
                    {formatCostShort(convertCurrency(cacheAnalysis.cost1h), currencySymbol)}
                  </td>
                </tr>
                {cheaperTTL !== 'same' && (
                  <tr>
                    <td className="muted">Savings</td>
                    <td className={`num${cheaperTTL === '5min' ? ' cost' : ''}`}>
                      {cheaperTTL === '5min'
                        ? `${formatCostShort(convertCurrency(savings5m), currencySymbol)} (${Math.round(savings5m / cacheAnalysis.cost1h * 100)}%)`
                        : '—'}
                    </td>
                    <td className={`num${cheaperTTL === '1h' ? ' cost' : ''}`}>
                      {cheaperTTL === '1h'
                        ? `${formatCostShort(convertCurrency(savings1h), currencySymbol)} (${Math.round(savings1h / cacheAnalysis.cost5min * 100)}%)`
                        : '—'}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Per-session tool summary */}
      {toolStats.length > 0 && (
        <div className="tool-summary">
          {toolStats.map((t, i) => (
            <span key={i}>
              {t.name} ×{t.count}
              {t.errors > 0 && <span className="tool-error-count"> ({t.errors} error{t.errors > 1 ? 's' : ''})</span>}
              {i < toolStats.length - 1 && ', '}
            </span>
          ))}
        </div>
      )}

      <div className="filter-bar">
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className="muted">Cost divider every</span>
          <input
            type="number"
            step="1"
            min="1"
            value={costGroupSize}
            onChange={e => {
              const v = parseInt(e.target.value)
              if (!isNaN(v) && v > 0) setCostGroupSize(v)
            }}
            style={{ width: '60px' }}
          />
          <span className="muted">{currencySymbol}</span>
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className="muted">Highlight messages &gt;</span>
          <input
            type="number"
            step="0.01"
            min="0"
            value={costThreshold ?? ''}
            placeholder="off"
            onChange={e => handleThresholdChange(e.target.value)}
            style={{ width: '70px' }}
          />
          <span className="muted">{currencySymbol}</span>
        </label>
        <div style={{ marginLeft: 'auto' }}>
          <div className="export-buttons">
            <button onClick={handleExportSession}>Export Session</button>
          </div>
        </div>
      </div>

      <h3 style={{ margin: '12px 0 8px' }}>Messages ({session.messages.length})</h3>
      <MessageTable
        messages={session.messages}
        convertCurrency={convertCurrency}
        currencySymbol={currencySymbol}
        show5mCache={show5mCache}
        costGroupSize={costGroupSize}
        costThreshold={costThreshold}
        subAgents={session.subAgents}
        onAgentBadgeClick={handleAgentBadgeClick}
      />

      {hasAgents && (
        <>
          <h3 style={{ margin: '24px 0 8px' }}>Sub-agents ({session.subAgents.length})</h3>
          {session.subAgents.map((sa: SubAgent) => (
            <div
              key={sa.id}
              className="subagent-panel"
              ref={el => { if (el) agentPanelRefs.current.set(sa.id, el); else agentPanelRefs.current.delete(sa.id) }}
              id={`agent-${sa.id}`}
            >
              <div className="subagent-header" onClick={() => toggleAgent(sa.id)}>
                <span>
                  <strong>{sa.agentType || sa.id.slice(0, 8)}</strong>
                  <span className="muted"> &mdash; {sa.messages.length} messages</span>
                </span>
                <span className="cost">{formatCostShort(convertCurrency(sa.totalCostUSD), currencySymbol)}</span>
              </div>
              {expandedAgents.has(sa.id) && (
                <div style={{ padding: '0 8px 8px' }}>
                  <MessageTable
                    messages={sa.messages}
                    convertCurrency={convertCurrency}
                    currencySymbol={currencySymbol}
                    show5mCache={show5mCache}
                    costGroupSize={costGroupSize}
                    costThreshold={costThreshold}
                  />
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {/* Floating back button */}
      {sourceRowIndex !== null && (
        <button className="floating-back-btn" onClick={handleBackToMessage}>
          ↑ Back to message #{sourceRowIndex + 1}
        </button>
      )}
    </div>
  )
}
