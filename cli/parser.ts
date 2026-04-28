// cli/parser.ts — Server-side JSONL session parser

import * as fs from 'fs'
import * as path from 'path'
import type { ParsedMessage, ParsedSession, ParsedSubAgent } from '../src/lib/types'

// --- Raw JSONL entry shapes ---

interface RawUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  cache_creation?: {
    ephemeral_5m_input_tokens?: number
    ephemeral_1h_input_tokens?: number
  }
  server_tool_use?: {
    web_search_requests?: number
  }
}

interface RawContentBlock {
  type: string
  text?: string
  name?: string
  id?: string
  input?: unknown
}

interface RawAssistantMessage {
  id: string
  model: string
  role: 'assistant'
  stop_reason: string | null
  content: RawContentBlock[]
  usage: RawUsage
}

interface RawUserMessage {
  role: 'user'
  content: string | RawContentBlock[]
}

interface RawAssistantEntry {
  type: 'assistant'
  uuid: string
  timestamp: string
  sessionId: string
  cwd?: string
  gitBranch?: string
  version?: string
  message: RawAssistantMessage
}

interface RawUserEntry {
  type: 'user'
  uuid: string
  timestamp: string
  sessionId: string
  cwd?: string
  gitBranch?: string
  version?: string
  message: RawUserMessage
}

type RawEntry = RawAssistantEntry | RawUserEntry | { type: string; [key: string]: unknown }

// --- Internal tracking ---

interface IndexedAssistant {
  lineIndex: number
  entry: RawAssistantEntry
}

interface IndexedUser {
  lineIndex: number
  entry: RawUserEntry
}

// --- Result type for parseJsonlContent ---

interface ParsedContent {
  messages: ParsedMessage[]
  cwd: string
  gitBranch: string
  version: string
  models: string[]
  modelCounts: Record<string, number>
  startTime: string
  endTime: string
}

// --- Public API ---

export interface EffortEvent {
  timestamp: string
  effort: string
  sessionId?: string
}

/**
 * Lightweight scan of JSONL content to extract effort level change events.
 */
export function scanEffortEvents(content: string, sessionId?: string): EffortEvent[] {
  const events: EffortEvent[] = []
  for (const line of content.split('\n')) {
    if (!line.trim()) continue
    let entry: any
    try { entry = JSON.parse(line) } catch { continue }
    if (entry.type !== 'user') continue
    const c = entry.message?.content
    if (typeof c !== 'string') continue
    const cmdMatch = c.match(/<command-name>\/effort<\/command-name>\s*<command-message>[^<]*<\/command-message>\s*<command-args>([^<]*)<\/command-args>/)
    if (cmdMatch && cmdMatch[1].trim()) {
      events.push({ timestamp: entry.timestamp, effort: cmdMatch[1].trim(), sessionId })
      continue
    }
    const stdoutMatch = c.match(/<local-command-stdout>Set effort level to (\w+)/)
    if (stdoutMatch) {
      events.push({ timestamp: entry.timestamp, effort: stdoutMatch[1], sessionId })
    }
  }
  return events
}

/**
 * Parse raw JSONL text into structured session data.
 * Handles deduplication of streaming chunks and extraction of cost-relevant fields.
 */
export function parseJsonlContent(content: string, sessionId: string, initialEffort?: string | null): ParsedContent {
  const lines = content.split('\n').filter(l => l.trim().length > 0)

  // First pass: collect entries
  const assistantMap = new Map<string, IndexedAssistant>() // keyed by message.id
  const userEntries: IndexedUser[] = []
  // Tool results keyed by tool_use_id → brief preview + error status
  const toolResultMap = new Map<string, { name: string; preview: string; fullResult: string; isError: boolean }>()

  let cwd = ''
  let gitBranch = ''
  let version = ''
  let metadataFound = false

  for (let i = 0; i < lines.length; i++) {
    let entry: RawEntry
    try {
      entry = JSON.parse(lines[i])
    } catch {
      continue // skip malformed lines
    }

    // Capture session metadata from first entry that has it
    if (!metadataFound && 'cwd' in entry && entry.cwd) {
      cwd = entry.cwd as string
      gitBranch = (entry.gitBranch as string) || ''
      version = (entry.version as string) || ''
      metadataFound = true
    }

    if (entry.type === 'assistant') {
      const ae = entry as RawAssistantEntry
      // Skip synthetic models
      if (ae.message.model === '<synthetic>') continue

      const msgId = ae.message.id
      const existing = assistantMap.get(msgId)

      if (!existing) {
        assistantMap.set(msgId, { lineIndex: i, entry: ae })
      } else {
        // Keep the one with non-null stop_reason, or the later one
        if (ae.message.stop_reason !== null) {
          assistantMap.set(msgId, { lineIndex: i, entry: ae })
        } else if (existing.entry.message.stop_reason === null) {
          // Both null — keep later
          assistantMap.set(msgId, { lineIndex: i, entry: ae })
        }
        // else: existing has stop_reason, new doesn't — keep existing
      }
    } else if (entry.type === 'user') {
      const ue = entry as RawUserEntry
      const isMeta = (entry as any).isMeta === true
      const isToolResult = (entry as any).toolUseResult !== undefined

      if (isToolResult || isMeta) {
        // Extract tool result previews to attach to preceding assistant message
        const content = ue.message?.content
        if (Array.isArray(content)) {
          for (const block of content as any[]) {
            if (block.type === 'tool_result' && block.tool_use_id) {
              const resultContent = typeof block.content === 'string'
                ? block.content
                : Array.isArray(block.content)
                  ? (block.content as any[]).find((c: any) => c.type === 'text')?.text ?? ''
                  : ''
              const fullStr = String(resultContent)
              toolResultMap.set(block.tool_use_id, {
                name: '', // will be filled from the assistant's tool_use block
                preview: fullStr.slice(0, 120),
                fullResult: fullStr,
                isError: block.is_error === true,
              })
            }
          }
        }
      } else if (ue.timestamp && ue.message?.role === 'user') {
        userEntries.push({ lineIndex: i, entry: ue })
      }
    }
    // Skip all other types (progress, system, file-history-snapshot, etc.)
  }

  // Merge assistant and user entries, sorted by line index
  type IndexedItem = { lineIndex: number; kind: 'assistant'; entry: RawAssistantEntry }
    | { lineIndex: number; kind: 'user'; entry: RawUserEntry }

  const merged: IndexedItem[] = []

  for (const indexed of assistantMap.values()) {
    merged.push({ lineIndex: indexed.lineIndex, kind: 'assistant', entry: indexed.entry })
  }
  for (const indexed of userEntries) {
    merged.push({ lineIndex: indexed.lineIndex, kind: 'user', entry: indexed.entry })
  }

  merged.sort((a, b) => a.lineIndex - b.lineIndex)

  // Build ParsedMessages
  const messages: ParsedMessage[] = []
  const modelCounts = new Map<string, number>()
  let currentEffort: string | null = initialEffort ?? null

  for (const item of merged) {
    if (item.kind === 'assistant') {
      const msg = item.entry.message
      const usage = msg.usage

      const model = msg.model
      modelCounts.set(model, (modelCounts.get(model) || 0) + 1)

      // Extract text preview and full text
      const { preview, fullText } = extractText(msg.content)

      // Extract tool calls with results
      const toolUseBlocks = msg.content.filter(b => b.type === 'tool_use' && b.name)
      const toolCalls = toolUseBlocks.map(b => b.name!)

      // Attach tool results from the toolResultMap
      const toolResults: Array<{ name: string; toolInput: string; preview: string; fullResult: string; isError: boolean; agentId?: string }> = []
      for (const block of toolUseBlocks) {
        const result = toolResultMap.get(block.id!)
        if (result) {
          // Extract a readable summary of tool input
          const rawInput = block.input as Record<string, unknown> | undefined
          const toolInput = rawInput ? summarizeToolInput(block.name!, rawInput) : ''
          const entry: { name: string; toolInput: string; preview: string; fullResult: string; isError: boolean; agentId?: string } = {
            name: block.name!,
            toolInput,
            preview: result.preview,
            fullResult: result.fullResult,
            isError: result.isError,
          }
          // Extract agentId from Agent tool input
          if (block.name === 'Agent' && block.input && typeof block.input === 'object') {
            const agentId = (block.input as any).agentId
            if (agentId) entry.agentId = agentId
          }
          toolResults.push(entry)
        }
      }

      // Cache breakdown
      const cacheCreation5m = usage.cache_creation?.ephemeral_5m_input_tokens ?? 0
      const cacheCreation1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0

      // Web search requests
      const webSearchRequests = usage.server_tool_use?.web_search_requests ?? 0

      // Detect thinking blocks
      const hasThinking = msg.content.some(b => b.type === 'thinking')

      messages.push({
        uuid: item.entry.uuid,
        timestamp: item.entry.timestamp,
        model,
        role: 'assistant',
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheCreation5mTokens: cacheCreation5m,
        cacheCreation1hTokens: cacheCreation1h,
        cacheReadTokens: usage.cache_read_input_tokens,
        webSearchRequests,
        preview,
        fullText,
        toolCalls,
        toolResults,
        effort: currentEffort,
        hasThinking,
      })
    } else {
      // User message — only include if it has meaningful text content
      const ue = item.entry
      const content = ue.message.content

      // Track effort level changes from /effort commands
      if (typeof content === 'string') {
        const effortMatch = content.match(/<command-name>\/effort<\/command-name>\s*<command-message>[^<]*<\/command-message>\s*<command-args>([^<]*)<\/command-args>/)
        if (effortMatch && effortMatch[1].trim()) {
          currentEffort = effortMatch[1].trim()
          continue
        }
        // Also detect effort from local-command-stdout confirmations
        const stdoutMatch = content.match(/<local-command-stdout>Set effort level to (\w+)/)
        if (stdoutMatch) {
          currentEffort = stdoutMatch[1]
          continue
        }
      }

      // Skip array content that's only tool_result blocks
      if (Array.isArray(content)) {
        const hasText = (content as RawContentBlock[]).some(b => b.type === 'text' && b.text?.trim())
        if (!hasText) continue
      }

      const { preview, fullText } = typeof content === 'string'
        ? { preview: content.slice(0, 100), fullText: content }
        : extractText(content as RawContentBlock[])

      // Skip if preview is empty or just XML/system tags
      if (!preview.trim() || preview.startsWith('<')) continue

      messages.push({
        uuid: ue.uuid,
        timestamp: ue.timestamp,
        model: '',
        role: 'user',
        inputTokens: 0,
        outputTokens: 0,
        cacheCreation5mTokens: 0,
        cacheCreation1hTokens: 0,
        cacheReadTokens: 0,
        webSearchRequests: 0,
        preview,
        fullText,
        toolCalls: [],
        toolResults: [],
        effort: currentEffort,
        hasThinking: false,
      })
    }
  }

  // Models sorted by frequency (most used first)
  const models = [...modelCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([m]) => m)

  // Time range
  const timestamps = messages
    .map(m => m.timestamp)
    .filter(t => t)
    .sort()
  const startTime = timestamps[0] || ''
  const endTime = timestamps[timestamps.length - 1] || ''

  const modelCountsObj: Record<string, number> = {}
  for (const [k, v] of modelCounts) modelCountsObj[k] = v

  return { messages, cwd, gitBranch, version, models, modelCounts: modelCountsObj, startTime, endTime }
}

// --- Session file discovery ---

export interface SessionFile {
  jsonlPath: string
  sessionId: string
  subAgentFiles: SubAgentFile[]
}

export interface SubAgentFile {
  jsonlPath: string
  metaJsonPath: string | null
  subAgentId: string
}

/**
 * Discover all JSONL session files in the given directories.
 * Also finds sub-agent files in companion directories.
 */
export function discoverSessionFiles(dirs: string[]): SessionFile[] {
  const results: SessionFile[] = []

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue

    const entries = fs.readdirSync(dir)

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue

      const jsonlPath = path.join(dir, entry)
      const sessionId = path.basename(entry, '.jsonl')

      // Look for companion sub-agent directory: <sessionId>/subagents/
      const subAgentDir = path.join(dir, sessionId, 'subagents')
      const subAgentFiles: SubAgentFile[] = []

      if (fs.existsSync(subAgentDir)) {
        const subEntries = fs.readdirSync(subAgentDir)
        for (const se of subEntries) {
          if (!se.endsWith('.jsonl')) continue

          const subJsonlPath = path.join(subAgentDir, se)
          const subAgentId = path.basename(se, '.jsonl')
          const metaPath = path.join(subAgentDir, `${subAgentId}.meta.json`)
          const metaJsonPath = fs.existsSync(metaPath) ? metaPath : null

          subAgentFiles.push({ jsonlPath: subJsonlPath, metaJsonPath, subAgentId })
        }
      }

      results.push({ jsonlPath, sessionId, subAgentFiles })
    }
  }

  return results
}

/**
 * Parse a single session file and its sub-agents into a ParsedSession.
 */
export function parseSessionFile(file: SessionFile, initialEffort?: string | null): ParsedSession {
  const content = fs.readFileSync(file.jsonlPath, 'utf-8')
  const parsed = parseJsonlContent(content, file.sessionId, initialEffort)

  // Parse sub-agents
  const subAgents: ParsedSubAgent[] = []

  for (const sa of file.subAgentFiles) {
    const saContent = fs.readFileSync(sa.jsonlPath, 'utf-8')
    const saParsed = parseJsonlContent(saContent, sa.subAgentId)

    let agentType: string | null = null
    if (sa.metaJsonPath) {
      try {
        const meta = JSON.parse(fs.readFileSync(sa.metaJsonPath, 'utf-8'))
        agentType = meta.agentType || null
      } catch {
        // ignore malformed meta
      }
    }

    subAgents.push({
      id: sa.subAgentId,
      parentSessionId: file.sessionId,
      agentType,
      messages: saParsed.messages,
    })
  }

  // Sort sub-agents chronologically by first message timestamp
  subAgents.sort((a, b) => {
    const aTime = a.messages[0]?.timestamp || ''
    const bTime = b.messages[0]?.timestamp || ''
    return aTime.localeCompare(bTime)
  })

  return {
    id: file.sessionId,
    startTime: parsed.startTime,
    endTime: parsed.endTime,
    models: parsed.models,
    modelCounts: parsed.modelCounts,
    version: parsed.version,
    cwd: parsed.cwd,
    gitBranch: parsed.gitBranch,
    messages: parsed.messages,
    subAgents,
  }
}

// --- Helpers ---

function summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
  // Show the most relevant field for common tools
  switch (toolName) {
    case 'ToolSearch': return String(input.query || '')
    case 'Bash': return String(input.command || '')
    case 'Read': return String(input.file_path || '')
    case 'Write': return String(input.file_path || '')
    case 'Edit': return String(input.file_path || '')
    case 'Glob': return `${input.pattern || ''}${input.path ? ' in ' + input.path : ''}`
    case 'Grep': return `/${input.pattern || '/'} ${input.path || ''}`.trim()
    case 'Agent': return String(input.prompt || input.description || '')
    case 'Skill': return String(input.skill || '')
    case 'WebSearch': return String(input.query || '')
    case 'WebFetch': return String(input.url || '')
    default: {
      // For MCP tools and others, show key=value pairs
      const parts: string[] = []
      for (const [k, v] of Object.entries(input)) {
        if (v === undefined || v === null) continue
        const s = String(v)
        parts.push(`${k}: ${s.length > 100 ? s.slice(0, 100) + '...' : s}`)
      }
      return parts.join(', ')
    }
  }
}

function extractText(content: RawContentBlock[]): { preview: string; fullText: string } {
  const texts: string[] = []
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      texts.push(block.text)
    }
  }
  const fullText = texts.join('\n\n')
  return { preview: fullText.slice(0, 100), fullText }
}
