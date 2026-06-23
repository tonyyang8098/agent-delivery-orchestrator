import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import mammoth from 'mammoth'
import multer from 'multer'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'
import { readSheet } from 'read-excel-file/node'
import {
  AGENTS,
  ENVIRONMENTS,
  ENVIRONMENT_BRANCHES,
  WORKFLOW,
  slugify,
  type AgentArtifact,
  type DeploymentAccessBlocker,
  type EnvironmentBranch,
  type AgentMemory,
  type AgentName,
  type GateType,
  type LlmMode,
  type LlmProviderStatus,
  type LogEntry,
  type PendingLlmCall,
  type PeerReview,
  type PeerReviewStatus,
  type RequirementChatMessage,
  type RequirementsState,
  type Tone,
  type UploadedContextFile,
  type UploadedContextKind,
  type WorkflowStep,
} from '../src/orchestratorModel.ts'

type RunStatus =
  | 'requirements'
  | 'llm-approval'
  | 'blocked-on-access'
  | 'running'
  | 'paused'
  | 'waiting-for-human'
  | 'complete'

type OrchestratorRun = {
  id: string
  projectName: string
  repositoryName: string
  featureRequest: string
  requirements: RequirementsState
  branchName: string
  environmentBranches: EnvironmentBranch[]
  currentStepIndex: number
  mergeApproved: boolean
  prodApproved: boolean
  isRunning: boolean
  createdAt: string
  updatedAt: string
  logEntries: LogEntry[]
  artifacts: AgentArtifact[]
  peerReviews: PeerReview[]
  contextFiles: UploadedContextFile[]
  accessBlockers: DeploymentAccessBlocker[]
  pendingLlmCall?: PendingLlmCall
}

const app = express()
const parsePositiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback
}

const host = process.env.API_HOST ?? '127.0.0.1'
const port = parsePositiveInteger(process.env.API_PORT, 3001)
const stepDurationMs = parsePositiveInteger(process.env.STEP_DURATION_MS, 1300)
const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-5.4-mini'
const openaiClient = process.env.OPENAI_API_KEY ? new OpenAI() : null
const localLlmBaseUrl = process.env.LOCAL_LLM_BASE_URL?.trim()
const localLlmApiKey = process.env.LOCAL_LLM_API_KEY || 'local-dev'
const localLlmClient = localLlmBaseUrl
  ? new OpenAI({ apiKey: localLlmApiKey, baseURL: localLlmBaseUrl })
  : null
const localDefaultModel = process.env.LOCAL_LLM_DEFAULT_MODEL ?? 'Phi-4-mini-instruct'
const localReasoningModel = process.env.LOCAL_LLM_REASONING_MODEL ?? 'Qwen3.6-27B'
const localCoderModel = process.env.LOCAL_LLM_CODER_MODEL ?? 'Qwen3-Coder-Next'
const requireLlmApproval = process.env.LLM_REQUIRE_APPROVAL !== 'false'
const llmMaxOutputTokens = parsePositiveInteger(process.env.LLM_MAX_OUTPUT_TOKENS, 300)
const maxContextFiles = parsePositiveInteger(process.env.CONTEXT_FILE_LIMIT, 6)
const maxContextFileBytes = parsePositiveInteger(process.env.CONTEXT_FILE_MAX_BYTES, 5 * 1024 * 1024)

type RunnableLlmMode = Exclude<LlmMode, 'mixed'>

type LlmRoute = {
  provider: RunnableLlmMode
  model: string
  paid: boolean
  client: OpenAI | null
}

const agentEnvPrefix: Record<AgentName, string> = {
  'Business analyst agent': 'BA_AGENT',
  'Architect agent': 'ARCHITECT_AGENT',
  'Software agent': 'SOFTWARE_AGENT',
  'Tester agent': 'TESTER_AGENT',
  'DevOps agent': 'DEVOPS_AGENT',
}

const localDefaultModelForAgent = (agentName: AgentName) =>
  agentName === 'Software agent' ? localCoderModel : localReasoningModel

const parseLlmProvider = (value: string | undefined): RunnableLlmMode | null => {
  const normalized = value?.trim().toLowerCase()
  if (normalized === 'openai' || normalized === 'local' || normalized === 'mock') {
    return normalized
  }
  return null
}

const defaultLlmProvider = (): RunnableLlmMode => {
  const configured = parseLlmProvider(process.env.LLM_PROVIDER)
  if (configured) return configured
  if (localLlmClient) return 'local'
  if (openaiClient) return 'openai'
  return 'mock'
}

const getAgentConfiguredProvider = (agentName: AgentName): RunnableLlmMode => {
  const prefix = agentEnvPrefix[agentName]
  return parseLlmProvider(process.env[`${prefix}_PROVIDER`]) ?? defaultLlmProvider()
}

const getAgentModelForProvider = (
  agentName: AgentName,
  provider: RunnableLlmMode,
) => {
  const prefix = agentEnvPrefix[agentName]
  if (provider === 'openai') {
    return process.env[`${prefix}_OPENAI_MODEL`] || openaiModel
  }

  if (provider === 'local') {
    return (
      process.env[`${prefix}_LOCAL_MODEL`] ||
      process.env[`${prefix}_MODEL`] ||
      localDefaultModelForAgent(agentName) ||
      localDefaultModel
    )
  }

  return 'mock-local-persona'
}

const getAgentLlmRoute = (agentName: AgentName): LlmRoute => {
  const configuredProvider = getAgentConfiguredProvider(agentName)
  if (configuredProvider === 'openai' && openaiClient) {
    return {
      provider: 'openai',
      model: getAgentModelForProvider(agentName, 'openai'),
      paid: true,
      client: openaiClient,
    }
  }

  if (configuredProvider === 'local' && localLlmClient) {
    return {
      provider: 'local',
      model: getAgentModelForProvider(agentName, 'local'),
      paid: false,
      client: localLlmClient,
    }
  }

  return {
    provider: 'mock',
    model: 'mock-local-persona',
    paid: false,
    client: null,
  }
}

const modelPricingUsdPerMillion: Record<string, { input: number; output: number }> = {
  'gpt-5.4-mini': { input: 0.75, output: 4.5 },
}

const contextUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    files: maxContextFiles,
    fileSize: maxContextFileBytes,
  },
})

const runs = new Map<string, OrchestratorRun>()
const timers = new Map<string, NodeJS.Timeout>()
const inFlightSteps = new Set<string>()
let activeRunId: string | null = null

const personaPrompts: Record<AgentName, string> = {
  'Business analyst agent':
    'You are the Business Analyst agent. You interview the user until requirements are complete, create a baseline requirements document, convert approved scope and architecture into user stories, and revise that baseline when the user later expands scope or asks to add, modify, or delete features. Ask one clear question at a time when a request is ambiguous. Be precise and practical.',
  'Architect agent':
    'You are the Architect agent. Design the solution from the baseline requirements document. Define system boundaries, core components, data flow, integrations, non-functional constraints, architecture risks, and tradeoffs. Keep designs implementable for local developer handoff.',
  'Software agent':
    'You are the Software agent. Produce implementation notes, code design, branch-ready tasks, and engineering tradeoffs. Be concrete and avoid vague architecture language.',
  'Tester agent':
    'You are the Tester agent. Produce QA strategy, acceptance coverage, regression risks, and test evidence. Think about failure modes and environment-specific checks.',
  'DevOps agent':
    'You are the DevOps agent. Produce repository, pull request, deployment, environment, rollback, and release-control handoffs. Respect human approval gates. For AWS or Azure access setup, instruct the human with exact scoped requirements, verify setup before continuing, and create an access blocker when permissions or credentials are missing.',
}

const localStateDir = path.resolve(process.cwd(), 'local-state')
const agentMemoryPath = path.join(localStateDir, 'agent-memory.json')

const getAgentDefinition = (agentName: AgentName) =>
  AGENTS.find((agent) => agent.name === agentName) ?? AGENTS[0]

const createInitialAgentMemory = (): AgentMemory[] =>
  AGENTS.map((agent) => ({
    agentName: agent.name,
    specialization: agent.specialization,
    reviewLens: agent.reviewLens,
    learnedPatterns: ['Use the baseline requirements document as the source of truth.'],
    handoffCount: 0,
    reviewCount: 0,
    updatedAt: new Date().toISOString(),
  }))

const normalizeAgentMemory = (storedMemory: unknown): AgentMemory[] => {
  const stored = Array.isArray(storedMemory)
    ? (storedMemory as Partial<AgentMemory>[])
    : []

  return createInitialAgentMemory().map((initialMemory) => {
    const existing = stored.find(
      (memory) => memory.agentName === initialMemory.agentName,
    )

    return {
      ...initialMemory,
      learnedPatterns:
        Array.isArray(existing?.learnedPatterns) && existing.learnedPatterns.length > 0
          ? existing.learnedPatterns.slice(0, 8)
          : initialMemory.learnedPatterns,
      handoffCount:
        typeof existing?.handoffCount === 'number'
          ? existing.handoffCount
          : initialMemory.handoffCount,
      reviewCount:
        typeof existing?.reviewCount === 'number'
          ? existing.reviewCount
          : initialMemory.reviewCount,
      updatedAt:
        typeof existing?.updatedAt === 'string'
          ? existing.updatedAt
          : initialMemory.updatedAt,
    }
  })
}

const loadAgentMemory = () => {
  if (!existsSync(agentMemoryPath)) return createInitialAgentMemory()

  try {
    return normalizeAgentMemory(JSON.parse(readFileSync(agentMemoryPath, 'utf8')))
  } catch (error) {
    console.warn('Unable to load local agent memory. Starting with defaults.', error)
    return createInitialAgentMemory()
  }
}

let agentMemory = loadAgentMemory()

const saveAgentMemory = () => {
  try {
    mkdirSync(localStateDir, { recursive: true })
    writeFileSync(agentMemoryPath, `${JSON.stringify(agentMemory, null, 2)}\n`)
  } catch (error) {
    console.warn('Unable to save local agent memory.', error)
  }
}

const getAgentMemory = (agentName: AgentName) =>
  agentMemory.find((memory) => memory.agentName === agentName) ??
  createInitialAgentMemory().find((memory) => memory.agentName === agentName)!

const rememberAgentLesson = (
  agentName: AgentName,
  lesson: string,
  counters: Partial<Pick<AgentMemory, 'handoffCount' | 'reviewCount'>> = {},
) => {
  agentMemory = agentMemory.map((memory) => {
    if (memory.agentName !== agentName) return memory

    const learnedPatterns = [
      lesson,
      ...memory.learnedPatterns.filter((existingLesson) => existingLesson !== lesson),
    ].slice(0, 8)

    return {
      ...memory,
      learnedPatterns,
      handoffCount: memory.handoffCount + (counters.handoffCount ?? 0),
      reviewCount: memory.reviewCount + (counters.reviewCount ?? 0),
      updatedAt: new Date().toISOString(),
    }
  })
}

app.use(cors({ origin: [/^http:\/\/127\.0\.0\.1:\d+$/, /^http:\/\/localhost:\d+$/] }))
app.use(express.json({ limit: '1mb' }))

const createId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 10)}`

const timestamp = () =>
  new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

const makeLogEntry = (
  actor: string,
  message: string,
  tone: Tone = 'info',
): LogEntry => ({
  id: createId(),
  at: timestamp(),
  actor,
  message,
  tone,
})

const makeRequirementMessage = (
  role: RequirementChatMessage['role'],
  content: string,
): RequirementChatMessage => ({
  id: createId(),
  role,
  content,
  createdAt: new Date().toISOString(),
})

const normalizeText = (value: string) =>
  value
    .replace(/\r\n/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .trim()

const truncateText = (value: string, limit = 6000) => {
  const normalized = normalizeText(value)
  return normalized.length > limit
    ? `${normalized.slice(0, limit).trim()}\n\n[Truncated to ${limit} characters for local context.]`
    : normalized
}

const fileExtension = (filename: string) =>
  path.extname(filename).toLowerCase().replace('.', '')

const getContextKind = (filename: string): UploadedContextKind | null => {
  const extension = fileExtension(filename)
  if (['txt', 'md', 'markdown', 'docx'].includes(extension)) return 'requirements'
  if (['csv', 'xlsx'].includes(extension)) return 'sample-data'
  return null
}

const parseCsvRows = (value: string) => {
  const rows: string[][] = []
  let current = ''
  let row: string[] = []
  let inQuotes = false

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]
    const next = value[index + 1]

    if (char === '"' && inQuotes && next === '"') {
      current += '"'
      index += 1
      continue
    }

    if (char === '"') {
      inQuotes = !inQuotes
      continue
    }

    if (char === ',' && !inQuotes) {
      row.push(current.trim())
      current = ''
      continue
    }

    if ((char === '\n' || char === '\r') && !inQuotes) {
      if (char === '\r' && next === '\n') index += 1
      row.push(current.trim())
      if (row.some(Boolean)) rows.push(row)
      row = []
      current = ''
      continue
    }

    current += char
  }

  row.push(current.trim())
  if (row.some(Boolean)) rows.push(row)
  return rows
}

const rowsToPreview = (rows: unknown[][], limit = 6) =>
  rows
    .slice(0, limit)
    .map((row) => row.map((cell) => String(cell ?? '')).join(' | '))
    .join('\n')

const summarizeTabularContext = (
  filename: string,
  mimeType: string,
  size: number,
  rows: unknown[][],
): UploadedContextFile => {
  const header = rows[0]?.map((cell) => String(cell ?? '').trim()).filter(Boolean) ?? []
  const dataRows = rows.slice(header.length > 0 ? 1 : 0)
  const preview = rowsToPreview(rows)
  const extractedText = truncateText(
    [
      `Sample data file: ${filename}`,
      header.length > 0 ? `Columns: ${header.join(', ')}` : 'Columns: not detected',
      `Rows detected: ${dataRows.length}`,
      '',
      'Preview:',
      preview || 'No preview rows detected.',
    ].join('\n'),
  )

  return {
    id: createId(),
    name: filename,
    kind: 'sample-data',
    mimeType,
    size,
    summary: `${filename}: ${dataRows.length} rows, ${header.length} columns.`,
    extractedText,
    rowCount: dataRows.length,
    columns: header,
    createdAt: new Date().toISOString(),
  }
}

const parseUploadedContextFile = async (
  file: Express.Multer.File,
): Promise<UploadedContextFile> => {
  const kind = getContextKind(file.originalname)
  if (!kind) {
    throw new Error(
      `${file.originalname} is not supported. Upload .txt, .md, .docx, .csv, or .xlsx files.`,
    )
  }

  const extension = fileExtension(file.originalname)

  if (kind === 'requirements') {
    const rawText =
      extension === 'docx'
        ? (await mammoth.extractRawText({ buffer: file.buffer })).value
        : file.buffer.toString('utf8')
    const extractedText = truncateText(rawText)

    return {
      id: createId(),
      name: file.originalname,
      kind,
      mimeType: file.mimetype,
      size: file.size,
      summary: `${file.originalname}: ${firstSentence(extractedText) || 'Requirement text extracted.'}`,
      extractedText,
      createdAt: new Date().toISOString(),
    }
  }

  if (extension === 'csv') {
    const rows = parseCsvRows(file.buffer.toString('utf8'))
    return summarizeTabularContext(file.originalname, file.mimetype, file.size, rows)
  }

  const rows = await readSheet(file.buffer)
  return summarizeTabularContext(file.originalname, file.mimetype, file.size, rows)
}

const parseUploadedContextFiles = async (
  files: Express.Multer.File[] = [],
) => Promise.all(files.map((file) => parseUploadedContextFile(file)))

const getLlmRoutes = () =>
  AGENTS.map((agent) => {
    const route = getAgentLlmRoute(agent.name)
    return {
      agentName: agent.name,
      provider: route.provider,
      model: route.model,
    }
  })

const summarizeModelLabels = (models: string[]) => {
  const uniqueModels = [...new Set(models)]
  if (uniqueModels.length === 0) return 'mock-local-persona'
  if (uniqueModels.length === 1) return uniqueModels[0]
  return `${uniqueModels.length} routed models`
}

const getLlmProvider = (): LlmProviderStatus => {
  const routes = getLlmRoutes()
  const providers = [...new Set(routes.map((route) => route.provider))]
  const mode: LlmMode =
    providers.length === 1 ? providers[0] : 'mixed'

  return {
    mode,
    model: summarizeModelLabels(routes.map((route) => route.model)),
    configured: routes.some((route) => route.provider !== 'mock'),
    routes,
    paidFallbackModel: openaiClient ? openaiModel : undefined,
    localBaseUrl: localLlmBaseUrl,
  }
}

const estimateTokens = (value: string) => Math.ceil(value.length / 4)

const estimateCost = (model: string, inputTokens: number, outputTokens: number) => {
  const pricing = modelPricingUsdPerMillion[model] ?? modelPricingUsdPerMillion['gpt-5.4-mini']
  const estimatedInputCostUsd = (inputTokens / 1_000_000) * pricing.input
  const estimatedOutputCostUsd = (outputTokens / 1_000_000) * pricing.output

  return {
    estimatedInputCostUsd,
    estimatedOutputCostUsd,
    estimatedTotalCostUsd: estimatedInputCostUsd + estimatedOutputCostUsd,
  }
}

type PendingLlmEstimateInput = {
  model: string
  inputText: string
  outputTokenMultiplier?: number
}

const makePendingLlmCall = (
  kind: PendingLlmCall['kind'],
  title: string,
  description: string,
  estimateInputs: PendingLlmEstimateInput[],
): PendingLlmCall => {
  const estimates = estimateInputs.map((estimateInput) => {
    const estimatedInputTokens = estimateTokens(estimateInput.inputText)
    const maxOutputTokens =
      llmMaxOutputTokens * (estimateInput.outputTokenMultiplier ?? 1)
    const costs = estimateCost(
      estimateInput.model,
      estimatedInputTokens,
      maxOutputTokens,
    )
    return {
      estimatedInputTokens,
      maxOutputTokens,
      ...costs,
    }
  })

  return {
    id: createId(),
    kind,
    title,
    description,
    provider: 'openai',
    model: summarizeModelLabels(estimateInputs.map((input) => input.model)),
    estimatedInputTokens: estimates.reduce(
      (total, estimate) => total + estimate.estimatedInputTokens,
      0,
    ),
    maxOutputTokens: estimates.reduce(
      (total, estimate) => total + estimate.maxOutputTokens,
      0,
    ),
    estimatedInputCostUsd: estimates.reduce(
      (total, estimate) => total + estimate.estimatedInputCostUsd,
      0,
    ),
    estimatedOutputCostUsd: estimates.reduce(
      (total, estimate) => total + estimate.estimatedOutputCostUsd,
      0,
    ),
    estimatedTotalCostUsd: estimates.reduce(
      (total, estimate) => total + estimate.estimatedTotalCostUsd,
      0,
    ),
    createdAt: new Date().toISOString(),
  }
}

const setPendingLlmCall = (run: OrchestratorRun, pendingLlmCall: PendingLlmCall) => {
  run.pendingLlmCall = pendingLlmCall
  run.isRunning = false
  appendLog(
    run,
    'LLM approval',
    `${pendingLlmCall.title} is waiting for approval. Estimated cost: $${pendingLlmCall.estimatedTotalCostUsd.toFixed(6)}.`,
    'warning',
  )
}

type BaRequirementDecision = {
  status: 'clarifying' | 'complete'
  question?: string
  requirementsDocument?: string
  summary?: string
}

const mockQuestions = [
  'Who are the primary users, and what problem should this solve for them first?',
  'What are the must-have workflows, inputs, outputs, and approval rules for the first usable version?',
  'What acceptance criteria, edge cases, integrations, and audit or security requirements should the team treat as non-negotiable?',
]

const stripJsonFence = (value: string) =>
  value
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim()

const parseBaDecision = (value: string): BaRequirementDecision => {
  const parsed = JSON.parse(stripJsonFence(value)) as Partial<BaRequirementDecision>
  if (parsed.status === 'complete' && parsed.requirementsDocument) {
    return {
      status: 'complete',
      requirementsDocument: parsed.requirementsDocument,
      summary: parsed.summary,
    }
  }

  if (parsed.question) {
    return {
      status: 'clarifying',
      question: parsed.question,
      summary: parsed.summary,
    }
  }

  throw new Error('BA response did not include a question or requirements document.')
}

const buildMockRequirementsDocument = (run: OrchestratorRun) => {
  const userMessages = run.requirements.messages
    .filter((message) => message.role === 'user')
  const answers = userMessages
    .slice(1)
    .map((message, index) => `${index + 1}. ${message.content}`)
    .join('\n')
  const changeRequests = userMessages
    .slice(4)
    .map((message, index) => `${index + 1}. ${message.content}`)
    .join('\n')
  const requirementContext = run.contextFiles
    .filter((file) => file.kind === 'requirements')
    .map((file) => `- ${file.name}: ${file.summary}`)
    .join('\n')
  const sampleDataContext = run.contextFiles
    .filter((file) => file.kind === 'sample-data')
    .map((file) => `- ${file.name}: ${file.summary}`)
    .join('\n')

  return [
    '# Baseline Requirements Document',
    '',
    '## Project',
    `Name: ${run.projectName}`,
    `GitHub repository: ${run.repositoryName}`,
    `Feature branch: ${run.branchName}`,
    '',
    '## Environment Branch Strategy',
    formatEnvironmentBranchPlan(run.environmentBranches),
    '',
    `## Feature`,
    run.featureRequest,
    '',
    '## User And Business Context',
    answers || 'Captured through the BA clarification chat.',
    '',
    ...(requirementContext
      ? [
          '## Uploaded Requirement Context',
          requirementContext,
          '',
        ]
      : []),
    ...(sampleDataContext
      ? [
          '## Uploaded Sample Data Context',
          sampleDataContext,
          '',
        ]
      : []),
    ...(changeRequests
      ? [
          '## Scope Changes And Revisions',
          changeRequests,
          '',
        ]
      : []),
    '## Functional Scope',
    '- Convert the clarified request into a first usable implementation plan.',
    '- Preserve approval, audit, QA, and deployment expectations as project constraints.',
    '',
    '## Acceptance Criteria',
    '- Developer agents can identify the initial feature scope without another discovery pass.',
    '- Tester agent can derive functional and regression coverage.',
    '- DevOps agent can identify environment and release-control requirements.',
    '',
    '## Handoff Notes',
    'This baseline came from local mock BA mode. Add OPENAI_API_KEY to generate richer requirements from the model.',
  ].join('\n')
}

const createMockBaDecision = (run: OrchestratorRun): BaRequirementDecision => {
  const hasBaseline = Boolean(run.requirements.baselineArtifactId)
  const userAnswerCount = run.requirements.messages.filter(
    (message) => message.role === 'user',
  ).length - 1

  if (!hasBaseline && userAnswerCount < mockQuestions.length) {
    return {
      status: 'clarifying',
      question: mockQuestions[userAnswerCount],
    }
  }

  return {
    status: 'complete',
    requirementsDocument: buildMockRequirementsDocument(run),
    summary: 'Baseline requirements are ready for developer handoff.',
  }
}

const getBaselineArtifact = (run: OrchestratorRun) =>
  run.requirements.baselineArtifactId
    ? run.artifacts.find((artifact) => artifact.id === run.requirements.baselineArtifactId)
    : undefined

const getBaselineContextFile = (run: OrchestratorRun) => {
  const baseline = getBaselineArtifact(run)
  if (!baseline) {
    return 'Context file baseline-requirements.md is not available yet.'
  }

  return [
    'Context file: baseline-requirements.md',
    '```markdown',
    baseline.output,
    '```',
  ].join('\n')
}

const getUploadedContextFiles = (run: OrchestratorRun) => {
  if (run.contextFiles.length === 0) {
    return 'Uploaded context files: none'
  }

  return [
    'Uploaded context files:',
    ...run.contextFiles.map((file) =>
      [
        `Context file: ${file.name}`,
        `Kind: ${file.kind}`,
        `Summary: ${file.summary}`,
        file.columns?.length ? `Columns: ${file.columns.join(', ')}` : '',
        typeof file.rowCount === 'number' ? `Rows: ${file.rowCount}` : '',
        '```text',
        file.extractedText,
        '```',
      ]
        .filter(Boolean)
        .join('\n'),
    ),
  ].join('\n\n')
}

const getRecentPeerReviewContext = (run: OrchestratorRun) => {
  const reviews = run.peerReviews
    .slice(-8)
    .map(
      (review) =>
        `${review.reviewerAgent} reviewed ${review.targetAgent} during ${review.stepLabel}: ${review.status} - ${review.recommendation}`,
    )
    .join('\n')

  return reviews ? `Recent team reviews:\n${reviews}` : 'Recent team reviews: none'
}

const buildBaRequirementInput = (run: OrchestratorRun) => {
  const transcript = run.requirements.messages
    .map((message) => `${message.role === 'ba' ? 'BA' : 'User'}: ${message.content}`)
    .join('\n')
  const currentBaseline = getBaselineArtifact(run)

  return [
    `Feature request: ${run.featureRequest}`,
    currentBaseline
      ? `Current baseline requirements document:\n${currentBaseline.output}`
      : 'Current baseline requirements document: none yet.',
    '',
    getUploadedContextFiles(run),
    '',
    'Requirement interview transcript:',
    transcript || 'No transcript yet.',
    '',
    currentBaseline
      ? 'The user may now be expanding scope or asking to add, modify, or delete features. If the latest request is clear, return a revised complete baseline requirements document that preserves unchanged requirements and explicitly applies the requested changes. If the latest request is ambiguous, return exactly one clarifying question.'
      : 'Decide whether requirements are complete enough to hand off to developer agents. If any material requirement is missing, return exactly one clarifying question.',
    'Prioritize these gaps: users/personas, business outcome, scope boundaries, workflows, data, rules, integrations, audit/security, acceptance criteria, edge cases, and deployment constraints.',
    '',
    'Return JSON only with one of these shapes:',
    '{"status":"clarifying","question":"one concise question","summary":"short reason"}',
    '{"status":"complete","requirementsDocument":"markdown baseline requirements document","summary":"short handoff summary"}',
  ].join('\n')
}

type LlmTextResult = {
  outputText: string
  provider: RunnableLlmMode
  model: string
}

const createLlmText = async (
  agentName: AgentName,
  input: string,
): Promise<LlmTextResult | null> => {
  const route = getAgentLlmRoute(agentName)
  if (route.provider === 'mock' || !route.client) return null

  if (route.provider === 'openai') {
    const response = await route.client.responses.create({
      model: route.model,
      instructions: personaPrompts[agentName],
      input,
      max_output_tokens: llmMaxOutputTokens,
    })

    return {
      outputText: response.output_text.trim(),
      provider: route.provider,
      model: route.model,
    }
  }

  const response = await route.client.chat.completions.create({
    model: route.model,
    messages: [
      { role: 'system', content: personaPrompts[agentName] },
      { role: 'user', content: input },
    ],
    max_tokens: llmMaxOutputTokens,
    temperature: 0.2,
  })
  const outputText = response.choices[0]?.message?.content?.trim()
  if (!outputText) throw new Error('Local LLM returned an empty response.')

  return {
    outputText,
    provider: route.provider,
    model: route.model,
  }
}

const createLlmBaDecision = async (
  run: OrchestratorRun,
  forceMock = false,
): Promise<BaRequirementDecision> => {
  if (forceMock) return createMockBaDecision(run)

  const userAnswerCount = run.requirements.messages.filter(
    (message) => message.role === 'user',
  ).length - 1
  if (userAnswerCount < 1) {
    return {
      status: 'clarifying',
      question:
        'What business outcome should this feature deliver, and who are the primary users for the first version?',
    }
  }

  const result = await createLlmText(
    'Business analyst agent',
    buildBaRequirementInput(run),
  )
  if (!result) return createMockBaDecision(run)

  return parseBaDecision(result.outputText)
}

const createRequirementsArtifact = (
  run: OrchestratorRun,
  requirementsDocument: string,
  route: Pick<AgentArtifact, 'provider' | 'model'>,
): AgentArtifact => ({
  id: createId(),
  stepId: 'intake',
  stepLabel: 'Feature intake',
  agentName: 'Business analyst agent',
  title: `Baseline requirements document v${
    run.artifacts.filter((artifact) => artifact.title.startsWith('Baseline requirements document')).length + 1
  }`,
  summary: firstSentence(requirementsDocument),
  output: requirementsDocument,
  provider: route.provider,
  model: route.model,
  createdAt: new Date().toISOString(),
})

const continueBaRequirements = async (
  run: OrchestratorRun,
  options: { approved?: boolean; forceMock?: boolean } = {},
) => {
  try {
    const hadBaseline = Boolean(run.requirements.baselineArtifactId)
    const userAnswerCount = run.requirements.messages.filter(
      (message) => message.role === 'user',
    ).length - 1
    const baRoute = getAgentLlmRoute('Business analyst agent')

    if (
      baRoute.paid &&
      requireLlmApproval &&
      !options.approved &&
      !options.forceMock &&
      userAnswerCount >= 1
    ) {
      const input = `${personaPrompts['Business analyst agent']}\n\n${buildBaRequirementInput(run)}`
      setPendingLlmCall(
        run,
        makePendingLlmCall(
          'ba-requirements',
          hadBaseline ? 'Revise BA baseline' : 'Continue BA requirements',
          hadBaseline
            ? 'Analyze the requested scope change and update the active baseline document.'
            : 'Analyze the requirements transcript and ask the next question or create the baseline document.',
          [{ model: baRoute.model, inputText: input }],
        ),
      )
      return
    }

    run.pendingLlmCall = undefined
    const decision = await createLlmBaDecision(run, options.forceMock)

    if (decision.status === 'complete' && decision.requirementsDocument) {
      const artifact = createRequirementsArtifact(
        run,
        decision.requirementsDocument,
        options.forceMock
          ? { provider: 'mock', model: 'mock-local-persona' }
          : { provider: baRoute.provider, model: baRoute.model },
      )
      run.artifacts = [...run.artifacts, artifact]
      run.requirements.status = 'complete'
      run.requirements.baselineArtifactId = artifact.id
      const peerReviews = createPeerReviews(run, WORKFLOW[0], [artifact])
      run.peerReviews = [...run.peerReviews, ...peerReviews].slice(-120)
      updateAgentMemoryFromStep(run, WORKFLOW[0], [artifact], peerReviews)
      if (!hadBaseline && run.currentStepIndex < 1) {
        run.currentStepIndex = 1
        run.isRunning = true
      }
      appendLog(
        run,
        'Business analyst agent',
        hadBaseline
          ? 'Baseline requirements document updated from BA scope chat.'
          : 'Baseline requirements document created and handed off to developer agents.',
        'success',
      )
      appendLog(
        run,
        'Team review',
        `${peerReviews.length} baseline checks completed before developer handoff.`,
        'success',
      )
      if (run.isRunning) scheduleRun(run.id)
      return
    }

    const question =
      decision.question ??
      'What acceptance criteria should determine whether this feature is ready for handoff?'
    run.requirements.messages.push(makeRequirementMessage('ba', question))
    appendLog(run, 'Business analyst agent', 'Clarifying question sent to the user.')
  } catch (error) {
    const hadBaseline = Boolean(run.requirements.baselineArtifactId)
    const fallback = createMockBaDecision(run)
    if (fallback.status === 'complete' && fallback.requirementsDocument) {
      const artifact = createRequirementsArtifact(run, fallback.requirementsDocument, {
        provider: 'mock',
        model: 'mock-local-persona',
      })
      artifact.summary =
        error instanceof Error
          ? `LLM requirement analysis failed: ${error.message}. Mock baseline generated.`
          : 'LLM requirement analysis failed. Mock baseline generated.'
      run.artifacts = [...run.artifacts, artifact]
      run.requirements.status = 'complete'
      run.requirements.baselineArtifactId = artifact.id
      const peerReviews = createPeerReviews(run, WORKFLOW[0], [artifact])
      run.peerReviews = [...run.peerReviews, ...peerReviews].slice(-120)
      updateAgentMemoryFromStep(run, WORKFLOW[0], [artifact], peerReviews)
      if (!hadBaseline && run.currentStepIndex < 1) {
        run.currentStepIndex = 1
        run.isRunning = true
      }
      appendLog(
        run,
        'Business analyst agent',
        hadBaseline
          ? 'Mock baseline requirements revision created after LLM fallback.'
          : 'Mock baseline requirements document created after LLM fallback.',
        'warning',
      )
      appendLog(
        run,
        'Team review',
        `${peerReviews.length} baseline checks completed before developer handoff.`,
        'success',
      )
      if (run.isRunning) scheduleRun(run.id)
      return
    }

    run.requirements.messages.push(
      makeRequirementMessage(
        'ba',
        fallback.question ??
          'What is the most important user workflow this first version must support?',
      ),
    )
    appendLog(
      run,
      'LLM provider',
      'BA clarification fell back to mock question.',
      'warning',
    )
  } finally {
    run.updatedAt = new Date().toISOString()
  }
}

const firstSentence = (value: string) => {
  const normalized = value.replace(/\s+/g, ' ').trim()
  const match = normalized.match(/^(.{1,180}?[.!?])\s/)
  return match?.[1] ?? normalized.slice(0, 180)
}

const cleanProjectName = (value: string) =>
  normalizeText(value)
    .replace(/[<>:"/\\|?*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)

const deriveProjectName = (projectName: string, featureRequest: string) =>
  cleanProjectName(projectName) ||
  cleanProjectName(firstSentence(featureRequest).replace(/[.!?]+$/g, '')) ||
  'Local Delivery Project'

const formatEnvironmentBranchPlan = (branches: EnvironmentBranch[]) =>
  branches
    .map(
      (branch) =>
        `${branch.promotionOrder}. ${branch.environment}: ${branch.branchName} from ${branch.sourceBranch}`,
    )
    .join('\n')

const deploymentStepEnvironments: Record<string, DeploymentAccessBlocker['environment']> = {
  'deploy-dev': 'Dev',
  'deploy-stage': 'Stage',
  'deploy-prod': 'Prod',
}

const getDeploymentEnvironment = (step: WorkflowStep) =>
  deploymentStepEnvironments[step.id]

const getActiveAccessBlocker = (run: OrchestratorRun) =>
  run.accessBlockers.find((blocker) => blocker.status === 'open')

const hasResolvedAccessForEnvironment = (
  run: OrchestratorRun,
  environment: DeploymentAccessBlocker['environment'],
) =>
  run.accessBlockers.some(
    (blocker) =>
      blocker.environment === environment && blocker.status === 'resolved',
  )

const buildDeploymentAccessBlocker = (
  run: OrchestratorRun,
  step: WorkflowStep,
  environment: DeploymentAccessBlocker['environment'],
): DeploymentAccessBlocker => ({
  id: createId(),
  status: 'open',
  environment,
  cloudProvider: 'AWS/Azure',
  action: `${step.label} for ${run.repositoryName}`,
  resource:
    environment === 'Prod'
      ? `${run.repositoryName} production subscription/account and prod branch`
      : `${run.repositoryName} ${environment.toLowerCase()} resource group/account and ${environment.toLowerCase()} branch`,
  missingAccess: [
    'Scoped AWS IAM role or Azure service principal/managed identity for this environment.',
    'Permission to read deployment artifacts and environment configuration.',
    'Permission to deploy only approved infrastructure/application changes for this environment.',
    'Secret access through a secret store or CI/CD secret, not committed files.',
  ],
  instructions: [
    `Create or confirm a scoped ${environment} deployment identity for AWS or Azure.`,
    `Grant the identity access only to ${environment} resources needed by ${run.repositoryName}.`,
    'Store credentials in local .env for local testing or in GitHub Actions secrets, Azure Key Vault, AWS Secrets Manager, or OIDC federation for CI/CD.',
    environment === 'Prod'
      ? 'Keep production access separate from dev/stage and require human production approval before use.'
      : 'Keep non-prod access separate from production access.',
    'Return here and choose Verify setup once the access requirement is complete.',
  ],
  evidence:
    'No cloud deployment adapter or scoped credential verification has been recorded for this environment yet.',
  requestedResolution:
    'Human must provide/confirm scoped cloud access. DevOps will verify the setup and resume only after this blocker is resolved.',
  createdAt: new Date().toISOString(),
})

const ensureDeploymentAccess = (
  run: OrchestratorRun,
  step: WorkflowStep,
) => {
  const environment = getDeploymentEnvironment(step)
  if (!environment) return null
  if (hasResolvedAccessForEnvironment(run, environment)) return null

  const existingBlocker = run.accessBlockers.find(
    (blocker) =>
      blocker.environment === environment && blocker.status === 'open',
  )
  if (existingBlocker) return existingBlocker

  const blocker = buildDeploymentAccessBlocker(run, step, environment)
  run.accessBlockers = [...run.accessBlockers, blocker]
  run.isRunning = false
  appendLog(
    run,
    'DevOps agent',
    `${environment} deployment is blocked until scoped AWS/Azure access is verified.`,
    'warning',
  )
  return blocker
}

type PurposeGuardrailResult =
  | { allowed: true }
  | { allowed: false; error: string }

const purposeGuardrailMessage =
  'This orchestrator only accepts software delivery work: feature or tool requests, requirement clarification, scope changes, and supporting requirement or sample data files.'

const deliveryActionPatterns = [
  /\b(build|create|develop|implement|add|change|modify|update|remove|delete|expand|design|architect|code|test|qa|debug|fix|refactor|migrate|integrate|automate|deploy|release|ship|generate|scaffold|plan|support|include|capture|store|track|route|notify|display|calculate|import|export|upload|manage)\b/i,
]

const deliveryObjectPatterns = [
  /\b(feature|tool|app|application|web app|website|api|service|backend|frontend|ui|ux|screen|dashboard|portal|system|workflow|form|report|module|component|endpoint|database|data model|schema|auth|login|role|permission|approval|approver|audit|notification|alert|checklist|onboarding|intake|routing|invoice|customer|admin|user story|requirement|acceptance criteria|csv|excel|spreadsheet|dataset|sample data|dev|stage|prod|environment|pull request|merge|branch|repository|deployment|document|directory|inventory|ticket|task|tracker|management|search|filter|validation|history|status|rule|integration|theme|mode)\b/i,
]

const unrelatedRequestPatterns = [
  /\b(tell me a joke|write\s+(?:me\s+)?(?:a\s+)?(?:poem|song|story|essay)|give me a recipe|translate this|summarize this article|do my homework|solve this math|generate trivia)\b/i,
  /\b(what'?s|what is|show me|give me)\s+(?:the\s+)?(?:weather|forecast|time|date|stock price|sports score|lottery number|horoscope)\b/i,
  /\b(who\s+(?:is|was|won)|what\s+is\s+the\s+capital|latest news|current news|celebrity gossip|movie recommendation|restaurant recommendation|travel itinerary)\b/i,
]

const generalQuestionPatterns = [
  /^(what|who|when|where|why)\b/i,
  /^how\s+(many|much|old|tall|far|long)\b/i,
  /^can you\s+(tell|answer|explain)\b/i,
]

const hasPattern = (patterns: RegExp[], value: string) =>
  patterns.some((pattern) => pattern.test(value))

const hasDeliveryAction = (value: string) =>
  hasPattern(deliveryActionPatterns, value)

const hasDeliveryPurpose = (value: string) =>
  hasDeliveryAction(value) || hasPattern(deliveryObjectPatterns, value)

const isGeneralQuestionOutsideWorkflow = (value: string) =>
  hasPattern(generalQuestionPatterns, value) && !hasDeliveryAction(value)

const looksLikeClarificationAnswer = (value: string) =>
  value.length <= 500 && !value.includes('?')

const checkRunPurpose = (
  featureRequest: string,
  contextFiles: UploadedContextFile[],
): PurposeGuardrailResult => {
  const requirementFiles = contextFiles.filter((file) => file.kind === 'requirements')
  const evaluationText = normalizeText(
    [
      featureRequest,
      ...requirementFiles.map((file) => `${file.summary}\n${file.extractedText}`),
    ]
      .filter(Boolean)
      .join('\n'),
  )

  if (!featureRequest && requirementFiles.length === 0) {
    return {
      allowed: false,
      error:
        'Start with a feature or tool request, or upload a requirement document. Sample data can be attached only as supporting context.',
    }
  }

  if (hasPattern(unrelatedRequestPatterns, evaluationText)) {
    return {
      allowed: false,
      error: `${purposeGuardrailMessage} Random questions or general assistant tasks are blocked.`,
    }
  }

  if (
    isGeneralQuestionOutsideWorkflow(evaluationText) ||
    !hasDeliveryPurpose(evaluationText)
  ) {
    return {
      allowed: false,
      error:
        `${purposeGuardrailMessage} Start a run with a software feature, tool, workflow, app, integration, QA, repository, or deployment request.`,
    }
  }

  return { allowed: true }
}

const checkRequirementMessagePurpose = (
  message: string,
  run: OrchestratorRun,
): PurposeGuardrailResult => {
  const evaluationText = normalizeText(message)
  const answeringBaQuestion = run.requirements.status === 'clarifying'

  if (hasPattern(unrelatedRequestPatterns, evaluationText)) {
    return {
      allowed: false,
      error: `${purposeGuardrailMessage} The BA chat is limited to this run's requirements and scope.`,
    }
  }

  if (isGeneralQuestionOutsideWorkflow(evaluationText)) {
    return {
      allowed: false,
      error:
        'The BA chat is only for clarifying, adding, modifying, or removing requirements for this software delivery run.',
    }
  }

  if (hasDeliveryPurpose(evaluationText)) return { allowed: true }
  if (answeringBaQuestion && looksLikeClarificationAnswer(evaluationText)) {
    return { allowed: true }
  }

  return {
    allowed: false,
    error:
      'Ask the BA to add, modify, delete, or clarify requirements for this run. Unrelated prompts are blocked.',
  }
}

const buildAgentInput = (
  run: OrchestratorRun,
  step: WorkflowStep,
  agentName: AgentName,
) => {
  const agent = getAgentDefinition(agentName)
  const memory = getAgentMemory(agentName)
  const priorArtifacts = run.artifacts
    .slice(-6)
    .map(
      (artifact) =>
        `${artifact.agentName} during ${artifact.stepLabel}: ${artifact.summary}`,
    )
    .join('\n')
  const activeAccessBlocker = getActiveAccessBlocker(run)

  return [
    `Project: ${run.projectName}`,
    `GitHub repository: ${run.repositoryName}`,
    `Feature request: ${run.featureRequest}`,
    `Feature branch: ${run.branchName}`,
    'Feature work starts from the dev branch. DevOps owns the environment branch setup and promotion path.',
    `Environment branch plan:\n${formatEnvironmentBranchPlan(run.environmentBranches)}`,
    `Current step: ${step.label}`,
    `Environment: ${step.environment}`,
    `Step objective: ${step.detail}`,
    `Assigned persona: ${agentName}`,
    `Specialization: ${agent.specialization}`,
    `Review responsibility: ${agent.reviewLens}`,
    step.id === 'design-and-stories'
      ? 'Parallel gate: the Architect agent produces the solution design while the Business analyst agent produces user stories. Developer handoff must not start until both outputs are complete.'
      : '',
    step.id === 'developer-handoff'
      ? 'Developer gate: use the finalized design and user stories from the prior step before assigning any software implementation work.'
      : '',
    step.agents.includes('DevOps agent')
      ? [
          'Cloud access rule: for AWS/Azure deployment, instruct the human with scoped access requirements, verify access before continuing, and create or honor an access blocker if permissions are missing.',
          activeAccessBlocker
            ? `Active access blocker: ${activeAccessBlocker.environment} ${activeAccessBlocker.action}. Missing access: ${activeAccessBlocker.missingAccess.join('; ')}`
            : 'Active access blocker: none.',
        ].join('\n')
      : '',
    '',
    getBaselineContextFile(run),
    '',
    getUploadedContextFiles(run),
    '',
    'Agent memory:',
    memory.learnedPatterns.map((lesson) => `- ${lesson}`).join('\n'),
    '',
    priorArtifacts ? `Recent handoffs:\n${priorArtifacts}` : 'Recent handoffs: none',
    getRecentPeerReviewContext(run),
    '',
    'Create the concrete handoff artifact for this step.',
    'Use these short markdown sections:',
    '1. Deliverable',
    '2. Evidence',
    '3. Risks / next handoff',
    '',
    'Keep it under 180 words. Do not claim that real GitHub, CI, deployment, or cloud actions happened unless a tool integration provided that evidence. Treat this as local orchestration output.',
  ].join('\n')
}

const createMockArtifact = (
  run: OrchestratorRun,
  step: WorkflowStep,
  agentName: AgentName,
): AgentArtifact => {
  const persona = agentName.replace(' agent', '')
  const agent = getAgentDefinition(agentName)
  const baseline = getBaselineArtifact(run)
  const memory = getAgentMemory(agentName)
  const uploadedContext =
    run.contextFiles.length > 0
      ? `Attached context: ${run.contextFiles.map((file) => file.name).join(', ')}.`
      : 'No attached context files were supplied.'
  const activeAccessBlocker = getActiveAccessBlocker(run)
  const output = [
    `### Deliverable`,
    `${persona} prepared the local handoff for ${step.label.toLowerCase()} against "${run.featureRequest}".`,
    '',
    `### Evidence`,
    baseline
      ? `Used baseline-requirements.md from ${baseline.title} as the shared context file.`
      : `Used the feature request as context because the baseline document is not ready yet.`,
    `Repository: ${run.repositoryName}.`,
    `Feature branch: ${run.branchName}, based from dev.`,
    `Environment branches: ${run.environmentBranches.map((branch) => branch.branchName).join(' -> ')}.`,
    activeAccessBlocker
      ? `Access blocker: ${activeAccessBlocker.environment} deployment needs ${activeAccessBlocker.missingAccess.join('; ')}.`
      : `Access blocker: none currently open.`,
    uploadedContext,
    `Specialist lens: ${agent.specialization}`,
    `The workflow advanced through ${step.environment} with simulated evidence for ${step.agents.join(', ')}.`,
    `Recent memory: ${memory.learnedPatterns[0] ?? 'No learned patterns yet.'}`,
    '',
    `### Risks / next handoff`,
    `Replace mock mode with OPENAI_API_KEY-backed calls, then connect this step to the real repository, CI, and deployment tools.`,
  ].join('\n')

  return {
    id: createId(),
    stepId: step.id,
    stepLabel: step.label,
    agentName,
    title: `${persona} handoff`,
    summary: `${persona} produced a local ${step.label.toLowerCase()} handoff.`,
    output,
    provider: 'mock',
    model: 'mock-local-persona',
    createdAt: new Date().toISOString(),
  }
}

const createLlmArtifact = async (
  run: OrchestratorRun,
  step: WorkflowStep,
  agentName: AgentName,
  forceMock = false,
): Promise<AgentArtifact> => {
  if (forceMock) return createMockArtifact(run, step, agentName)

  const result = await createLlmText(agentName, buildAgentInput(run, step, agentName))
  if (!result) return createMockArtifact(run, step, agentName)

  const persona = agentName.replace(' agent', '')

  return {
    id: createId(),
    stepId: step.id,
    stepLabel: step.label,
    agentName,
    title: `${persona} handoff`,
    summary: firstSentence(result.outputText),
    output: result.outputText,
    provider: result.provider,
    model: result.model,
    createdAt: new Date().toISOString(),
  }
}

const getPeerReviewStatus = (
  reviewerAgent: AgentName,
  artifact: AgentArtifact,
  step: WorkflowStep,
): PeerReviewStatus => {
  const output = artifact.output.toLowerCase()
  if (reviewerAgent === 'Business analyst agent' && !output.includes('baseline')) {
    return 'changes-requested'
  }

  if (
    (reviewerAgent === 'Architect agent' && ['design-and-stories', 'developer-handoff', 'build-code'].includes(step.id)) ||
    (reviewerAgent === 'Tester agent' && ['design-and-stories', 'developer-handoff', 'build-code', 'pull-request'].includes(step.id)) ||
    (reviewerAgent === 'DevOps agent' && ['design-and-stories', 'developer-handoff', 'check-in', 'pull-request', 'deploy-stage'].includes(step.id)) ||
    (reviewerAgent === 'Software agent' && ['design-and-stories', 'qa-code', 'deploy-stage', 'deploy-prod'].includes(step.id))
  ) {
    return 'watch'
  }

  return 'approved'
}

const getReviewRecommendation = (
  reviewerAgent: AgentName,
  step: WorkflowStep,
  status: PeerReviewStatus,
) => {
  const prefix =
    status === 'changes-requested'
      ? 'Add missing baseline traceability before this handoff is relied on.'
      : status === 'watch'
        ? 'Carry this forward as a watch item.'
        : 'No blocker found.'

  if (reviewerAgent === 'Business analyst agent') {
    return `${prefix} Keep ${step.label.toLowerCase()} aligned to the approved scope and acceptance criteria.`
  }

  if (reviewerAgent === 'Software agent') {
    return `${prefix} Keep implementation tasks small, dependency impact explicit, and branch work traceable.`
  }

  if (reviewerAgent === 'Architect agent') {
    return `${prefix} Keep system boundaries, data flow, integration assumptions, and technical tradeoffs explicit.`
  }

  if (reviewerAgent === 'Tester agent') {
    return `${prefix} Cover acceptance paths, edge cases, regression risk, and test evidence before the next gate.`
  }

  return `${prefix} Keep repository, deployment, rollback, and environment evidence ready for the release path.`
}

const createPeerReviews = (
  run: OrchestratorRun,
  step: WorkflowStep,
  artifacts: AgentArtifact[],
): PeerReview[] => {
  const baseline = getBaselineArtifact(run)

  return artifacts.flatMap((artifact) =>
    AGENTS.filter((agent) => agent.name !== artifact.agentName).map((reviewer) => {
      const status = getPeerReviewStatus(reviewer.name, artifact, step)
      const target = getAgentDefinition(artifact.agentName)

      return {
        id: createId(),
        stepId: step.id,
        stepLabel: step.label,
        reviewerAgent: reviewer.name,
        targetAgent: artifact.agentName,
        targetArtifactId: artifact.id,
        status,
        finding: `${reviewer.shortName} checked ${target.shortName}'s ${step.label.toLowerCase()} handoff against ${baseline?.title ?? 'the feature request'} using this review lens: ${reviewer.reviewLens}`,
        recommendation: getReviewRecommendation(reviewer.name, step, status),
        createdAt: new Date().toISOString(),
      }
    }),
  )
}

const updateAgentMemoryFromStep = (
  run: OrchestratorRun,
  step: WorkflowStep,
  artifacts: AgentArtifact[],
  peerReviews: PeerReview[],
) => {
  const baseline = getBaselineArtifact(run)

  artifacts.forEach((artifact) => {
    rememberAgentLesson(
      artifact.agentName,
      `${step.label}: anchor handoffs to ${baseline?.title ?? 'baseline-requirements.md'} and address peer review notes before the next gate.`,
      { handoffCount: 1 },
    )
  })

  peerReviews.forEach((review) => {
    const reviewer = getAgentDefinition(review.reviewerAgent)
    rememberAgentLesson(
      review.reviewerAgent,
      `${step.label}: reviewed ${review.targetAgent.replace(' agent', '')} through ${reviewer.reviewLens}`,
      { reviewCount: 1 },
    )

    if (review.status !== 'approved') {
      rememberAgentLesson(
        review.targetAgent,
        `${step.label}: ${review.reviewerAgent.replace(' agent', '')} flagged a ${review.status} review item: ${review.recommendation}`,
      )
    }
  })

  saveAgentMemory()
}

const createAgentArtifacts = async (
  run: OrchestratorRun,
  step: WorkflowStep,
  forceMock = false,
) => {
  const artifacts: AgentArtifact[] = []

  for (const agentName of step.agents) {
    try {
      artifacts.push(await createLlmArtifact(run, step, agentName, forceMock))
    } catch (error) {
      const fallback = createMockArtifact(run, step, agentName)
      fallback.summary =
        error instanceof Error
          ? `LLM call failed: ${error.message}. Mock handoff generated.`
          : 'LLM call failed. Mock handoff generated.'
      artifacts.push(fallback)
      appendLog(
        run,
        'LLM provider',
        `${agentName} fell back to mock output for ${step.label}.`,
        'warning',
      )
    }
  }

  run.artifacts = [...run.artifacts, ...artifacts].slice(-40)
  return artifacts
}

const getActiveRun = () =>
  activeRunId ? runs.get(activeRunId) ?? null : null

const getCurrentStep = (run: OrchestratorRun) => WORKFLOW[run.currentStepIndex]

const getRunFlags = (run: OrchestratorRun) => {
  const currentStep = getCurrentStep(run)
  const isComplete = run.currentStepIndex >= WORKFLOW.length
  const waitingForLlmApproval = Boolean(run.pendingLlmCall)
  const waitingForRequirements = run.requirements.status === 'clarifying'
  const waitingForAccess = Boolean(getActiveAccessBlocker(run))
  const waitingForMerge =
    Boolean(currentStep?.gate === 'merge') && !run.mergeApproved
  const waitingForProd =
    Boolean(currentStep?.gate === 'prod') && !run.prodApproved
  const isWaiting =
    !isComplete &&
    (waitingForLlmApproval ||
      waitingForRequirements ||
      waitingForAccess ||
      waitingForMerge ||
      waitingForProd)
  const progress = Math.round(
    (Math.min(run.currentStepIndex, WORKFLOW.length) / WORKFLOW.length) * 100,
  )
  const status: RunStatus = isComplete
    ? 'complete'
    : waitingForLlmApproval
      ? 'llm-approval'
    : waitingForRequirements
      ? 'requirements'
    : waitingForAccess
      ? 'blocked-on-access'
    : waitingForMerge || waitingForProd
      ? 'waiting-for-human'
      : run.isRunning
        ? 'running'
        : 'paused'

  return {
    currentStep,
    isComplete,
    waitingForLlmApproval,
    waitingForRequirements,
    waitingForAccess,
    waitingForMerge,
    waitingForProd,
    activeAccessBlocker: getActiveAccessBlocker(run),
    isWaiting,
    progress,
    status,
  }
}

const serializeRun = (run: OrchestratorRun) => ({
  ...run,
  ...getRunFlags(run),
  agentMemory,
  llmProvider: getLlmProvider(),
})

const appendLog = (
  run: OrchestratorRun,
  actor: string,
  message: string,
  tone: Tone = 'info',
) => {
  run.logEntries = [...run.logEntries, makeLogEntry(actor, message, tone)].slice(-30)
  run.updatedAt = new Date().toISOString()
}

const clearRunTimer = (runId: string) => {
  const timer = timers.get(runId)
  if (timer) {
    clearTimeout(timer)
    timers.delete(runId)
  }
}

const buildAgentStepApprovalInputs = (run: OrchestratorRun, step: WorkflowStep) =>
  step.agents
    .map((agentName) => ({
      agentName,
      route: getAgentLlmRoute(agentName),
      inputText: `${personaPrompts[agentName]}\n\n${buildAgentInput(run, step, agentName)}`,
    }))
    .filter(({ route }) => route.paid)
    .map(
      ({ route, inputText }) =>
        ({
          model: route.model,
          inputText,
        }) satisfies PendingLlmEstimateInput,
    )

const completeActiveStep = async (
  runId: string,
  options: { approved?: boolean; forceMock?: boolean } = {},
) => {
  const run = runs.get(runId)
  if (!run) return

  clearRunTimer(runId)
  if (inFlightSteps.has(runId)) return
  inFlightSteps.add(runId)

  try {
    const flags = getRunFlags(run)
    const isApprovedPendingAgentCall =
      Boolean(run.pendingLlmCall?.kind === 'agent-step') &&
      Boolean(options.approved || options.forceMock)
    if (
      !run.isRunning ||
      flags.isComplete ||
      (flags.isWaiting && !isApprovedPendingAgentCall)
    ) {
      return
    }

    const step = getCurrentStep(run)
    if (!step) return

    const accessBlocker = ensureDeploymentAccess(run, step)
    if (accessBlocker) return

    const paidApprovalInputs = buildAgentStepApprovalInputs(run, step)
    if (
      paidApprovalInputs.length > 0 &&
      requireLlmApproval &&
      !options.approved &&
      !options.forceMock
    ) {
      setPendingLlmCall(
        run,
        makePendingLlmCall(
          'agent-step',
          `${step.label} persona handoff`,
          `Run ${step.agents.join(' + ')} for ${step.label}.`,
          paidApprovalInputs,
        ),
      )
      return
    }

    run.pendingLlmCall = undefined
    appendLog(
      run,
      'LLM provider',
      `Running ${step.agents.join(' + ')} with ${
        options.forceMock ? 'mock' : getLlmProvider().mode
      } provider.`,
    )
    const newArtifacts = await createAgentArtifacts(run, step, options.forceMock)
    const peerReviews = createPeerReviews(run, step, newArtifacts)
    run.peerReviews = [...run.peerReviews, ...peerReviews].slice(-120)
    updateAgentMemoryFromStep(run, step, newArtifacts, peerReviews)
    appendLog(
      run,
      'Team review',
      `${peerReviews.length} cross-agent checks completed and local memory updated.`,
      'success',
    )

    appendLog(
      run,
      step.agents.join(' + '),
      `${step.label} complete. ${step.environment} handoff updated.`,
      'success',
    )

    run.currentStepIndex += 1
    run.updatedAt = new Date().toISOString()
    const nextFlags = getRunFlags(run)

    if (nextFlags.isComplete) {
      run.isRunning = false
      appendLog(run, 'Orchestrator', 'Release completed through production.', 'success')
      return
    }

    if (nextFlags.waitingForMerge) {
      run.isRunning = false
      appendLog(run, 'Human gate', 'Pull request is ready for manual merge.', 'warning')
      return
    }

    if (nextFlags.waitingForProd) {
      run.isRunning = false
      appendLog(
        run,
        'Human gate',
        'Production deployment is waiting for approval.',
        'warning',
      )
      return
    }

    scheduleRun(runId)
  } finally {
    inFlightSteps.delete(runId)
  }
}

const scheduleRun = (runId: string) => {
  const run = runs.get(runId)
  if (!run) return

  clearRunTimer(runId)
  const flags = getRunFlags(run)
  if (!run.isRunning || flags.isWaiting || flags.isComplete) return

  timers.set(
    runId,
    setTimeout(() => {
      void completeActiveStep(runId)
    }, stepDurationMs),
  )
}

const notFound = { error: 'Run not found.' }

app.get('/health', (_request, response) => {
  response.json({
    status: 'ok',
    service: 'agent-delivery-orchestrator-api',
    activeRunId,
    workflowSteps: WORKFLOW.length,
    llmProvider: getLlmProvider(),
    agentMemory,
  })
})

app.get('/api/workflow', (_request, response) => {
  response.json({
    workflow: WORKFLOW,
    agents: AGENTS,
    environments: ENVIRONMENTS,
    llmProvider: getLlmProvider(),
    agentMemory,
  })
})

app.get('/api/runs/active', (_request, response) => {
  const run = getActiveRun()
  response.json({ run: run ? serializeRun(run) : null })
})

app.get('/api/runs/:runId', (request, response) => {
  const run = runs.get(request.params.runId)
  if (!run) {
    response.status(404).json(notFound)
    return
  }

  response.json({ run: serializeRun(run) })
})

app.post('/api/runs', contextUpload.array('contextFiles', maxContextFiles), async (request, response) => {
  const requestedProjectName =
    typeof request.body?.projectName === 'string'
      ? request.body.projectName.trim()
      : ''
  const featureRequest =
    typeof request.body?.featureRequest === 'string'
      ? request.body.featureRequest.trim()
      : ''

  let parsedContextFiles: UploadedContextFile[]
  try {
    parsedContextFiles = await parseUploadedContextFiles(
      (request.files as Express.Multer.File[] | undefined) ?? [],
    )
  } catch (error) {
    response.status(400).json({
      error:
        error instanceof Error
          ? error.message
          : 'Unable to parse uploaded context files.',
    })
    return
  }

  const contextFiles = parsedContextFiles
  const derivedFeatureRequest =
    featureRequest ||
    contextFiles.find((file) => file.kind === 'requirements')?.summary ||
    contextFiles[0]?.summary ||
    ''

  if (!derivedFeatureRequest) {
    response.status(400).json({ error: 'featureRequest or a supported context file is required.' })
    return
  }

  const purposeGuardrail = checkRunPurpose(featureRequest, contextFiles)
  if (!purposeGuardrail.allowed) {
    response.status(400).json({ error: purposeGuardrail.error })
    return
  }

  if (activeRunId) clearRunTimer(activeRunId)

  const projectName = deriveProjectName(requestedProjectName, derivedFeatureRequest)
  const repositoryName = slugify(projectName) || 'local-delivery-project'
  const slug = slugify(derivedFeatureRequest) || 'new-local-work-item'
  const run: OrchestratorRun = {
    id: createId(),
    projectName,
    repositoryName,
    featureRequest: derivedFeatureRequest,
    requirements: {
      status: 'clarifying',
      messages: [makeRequirementMessage('user', derivedFeatureRequest)],
    },
    branchName: `feature/${slug}`,
    environmentBranches: ENVIRONMENT_BRANCHES,
    currentStepIndex: 0,
    mergeApproved: false,
    prodApproved: false,
    isRunning: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifacts: [],
    peerReviews: [],
    contextFiles,
    accessBlockers: [],
    logEntries: [
      makeLogEntry('User request', derivedFeatureRequest),
      makeLogEntry(
        'Orchestrator',
        'Run started. Business analyst agent is gathering requirements.',
        'success',
      ),
      makeLogEntry(
        'DevOps agent',
        `Prepared GitHub repository plan ${repositoryName} with environment branches dev, stage, and prod. Feature work starts from dev.`,
        'success',
      ),
      ...(contextFiles.length > 0
        ? [
            makeLogEntry(
              'Context upload',
              `${contextFiles.length} context file${contextFiles.length === 1 ? '' : 's'} attached to the run.`,
              'success',
            ),
          ]
        : []),
    ],
  }

  runs.set(run.id, run)
  activeRunId = run.id
  await continueBaRequirements(run)

  response.status(201).json({ run: serializeRun(run) })
})

app.post('/api/runs/:runId/requirements/messages', async (request, response) => {
  const run = runs.get(request.params.runId)
  if (!run) {
    response.status(404).json(notFound)
    return
  }

  const message =
    typeof request.body?.message === 'string' ? request.body.message.trim() : ''
  if (!message) {
    response.status(400).json({ error: 'message is required.' })
    return
  }

  const purposeGuardrail = checkRequirementMessagePurpose(message, run)
  if (!purposeGuardrail.allowed) {
    response.status(400).json({ error: purposeGuardrail.error })
    return
  }

  if (run.requirements.status === 'complete') {
    run.requirements.status = 'clarifying'
    clearRunTimer(run.id)
  }

  run.requirements.messages.push(makeRequirementMessage('user', message))
  appendLog(
    run,
    'User',
    run.requirements.baselineArtifactId
      ? 'Requirement scope change submitted.'
      : 'Requirement clarification answered.',
  )
  await continueBaRequirements(run)

  response.json({ run: serializeRun(run) })
})

app.post('/api/runs/:runId/llm/approve', async (request, response) => {
  const run = runs.get(request.params.runId)
  if (!run) {
    response.status(404).json(notFound)
    return
  }

  const pending = run.pendingLlmCall
  if (!pending) {
    response.status(409).json({ error: 'No LLM call is waiting for approval.' })
    return
  }

  appendLog(
    run,
    'User',
    `Approved ${pending.title}. Estimated cost: $${pending.estimatedTotalCostUsd.toFixed(6)}.`,
    'success',
  )

  if (pending.kind === 'ba-requirements') {
    await continueBaRequirements(run, { approved: true })
    response.json({ run: serializeRun(run) })
    return
  }

  run.isRunning = true
  await completeActiveStep(run.id, { approved: true })
  response.json({ run: serializeRun(run) })
})

app.post('/api/runs/:runId/llm/mock', async (request, response) => {
  const run = runs.get(request.params.runId)
  if (!run) {
    response.status(404).json(notFound)
    return
  }

  const pending = run.pendingLlmCall
  if (!pending) {
    response.status(409).json({ error: 'No LLM call is waiting for approval.' })
    return
  }

  appendLog(run, 'User', `Chose mock output for ${pending.title}.`, 'success')

  if (pending.kind === 'ba-requirements') {
    await continueBaRequirements(run, { forceMock: true })
    response.json({ run: serializeRun(run) })
    return
  }

  run.isRunning = true
  await completeActiveStep(run.id, { forceMock: true })
  response.json({ run: serializeRun(run) })
})

app.post('/api/runs/:runId/pause', (request, response) => {
  const run = runs.get(request.params.runId)
  if (!run) {
    response.status(404).json(notFound)
    return
  }

  const flags = getRunFlags(run)
  if (!flags.isComplete && !flags.isWaiting) {
    run.isRunning = false
    appendLog(run, 'Orchestrator', 'Run paused.')
  }
  clearRunTimer(run.id)

  response.json({ run: serializeRun(run) })
})

app.post('/api/runs/:runId/resume', (request, response) => {
  const run = runs.get(request.params.runId)
  if (!run) {
    response.status(404).json(notFound)
    return
  }

  const flags = getRunFlags(run)
  if (!flags.isComplete && !flags.isWaiting) {
    run.isRunning = true
    appendLog(run, 'Orchestrator', 'Run resumed.')
    scheduleRun(run.id)
  }

  response.json({ run: serializeRun(run) })
})

app.post('/api/runs/:runId/access/verify', (request, response) => {
  const run = runs.get(request.params.runId)
  if (!run) {
    response.status(404).json(notFound)
    return
  }

  const blocker = getActiveAccessBlocker(run)
  if (!blocker) {
    response.status(409).json({ error: 'No deployment access blocker is waiting for verification.' })
    return
  }

  const evidence =
    typeof request.body?.evidence === 'string' && request.body.evidence.trim()
      ? request.body.evidence.trim()
      : 'Human confirmed scoped cloud access is configured. Local prototype recorded verification; real AWS/Azure adapter checks will run when integrated.'

  blocker.status = 'resolved'
  blocker.evidence = evidence
  blocker.resolutionNote =
    'DevOps verified the human-provided access setup in local mode and resumed the deployment workflow.'
  blocker.lastCheckedAt = new Date().toISOString()
  blocker.resolvedAt = blocker.lastCheckedAt
  run.isRunning = true
  appendLog(
    run,
    'DevOps agent',
    `${blocker.environment} access blocker resolved. Deployment workflow resumed.`,
    'success',
  )
  scheduleRun(run.id)

  response.json({ run: serializeRun(run) })
})

app.post('/api/runs/:runId/access/still-blocked', (request, response) => {
  const run = runs.get(request.params.runId)
  if (!run) {
    response.status(404).json(notFound)
    return
  }

  const blocker = getActiveAccessBlocker(run)
  if (!blocker) {
    response.status(409).json({ error: 'No deployment access blocker is open.' })
    return
  }

  blocker.lastCheckedAt = new Date().toISOString()
  blocker.evidence =
    typeof request.body?.evidence === 'string' && request.body.evidence.trim()
      ? request.body.evidence.trim()
      : 'Human indicated access is still blocked. DevOps remains parked until permissions are resolved.'
  run.isRunning = false
  clearRunTimer(run.id)
  appendLog(
    run,
    'DevOps agent',
    `${blocker.environment} deployment remains blocked on AWS/Azure access.`,
    'warning',
  )

  response.json({ run: serializeRun(run) })
})

app.post('/api/runs/:runId/reset', (request, response) => {
  const run = runs.get(request.params.runId)
  if (!run) {
    response.status(404).json(notFound)
    return
  }

  clearRunTimer(run.id)
  runs.delete(run.id)
  if (activeRunId === run.id) activeRunId = null

  response.json({ run: null })
})

app.post('/api/runs/:runId/approvals/:gate', (request, response) => {
  const run = runs.get(request.params.runId)
  if (!run) {
    response.status(404).json(notFound)
    return
  }

  const gate = request.params.gate as GateType
  const currentStep = getCurrentStep(run)
  if (!currentStep?.gate || currentStep.gate !== gate) {
    response.status(409).json({ error: 'Run is not waiting on this gate.' })
    return
  }

  if (gate === 'merge') {
    run.mergeApproved = true
    run.currentStepIndex += 1
    run.isRunning = true
    appendLog(run, 'Human reviewer', 'Pull request manually merged into dev.', 'success')
    scheduleRun(run.id)
    response.json({ run: serializeRun(run) })
    return
  }

  if (gate === 'prod') {
    run.prodApproved = true
    run.currentStepIndex += 1
    run.isRunning = true
    appendLog(run, 'Human approver', 'Production release approved.', 'success')
    scheduleRun(run.id)
    response.json({ run: serializeRun(run) })
    return
  }

  response.status(400).json({ error: 'Unsupported approval gate.' })
})

app.use(
  (
    error: unknown,
    _request: express.Request,
    response: express.Response,
    next: express.NextFunction,
  ) => {
    if (error instanceof multer.MulterError) {
      response.status(400).json({
        error:
          error.code === 'LIMIT_FILE_SIZE'
            ? `Each context file must be ${Math.round(maxContextFileBytes / 1024 / 1024)} MB or smaller.`
            : `Context upload failed: ${error.message}`,
      })
      return
    }

    next(error)
  },
)

app.listen(port, host, () => {
  console.log(`Agent orchestrator API listening on http://${host}:${port}`)
})
