import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import OpenAI from 'openai'
import {
  AGENTS,
  ENVIRONMENTS,
  WORKFLOW,
  slugify,
  type AgentArtifact,
  type AgentMemory,
  type AgentName,
  type GateType,
  type LlmProviderStatus,
  type LogEntry,
  type PendingLlmCall,
  type PeerReview,
  type PeerReviewStatus,
  type RequirementChatMessage,
  type RequirementsState,
  type Tone,
  type WorkflowStep,
} from '../src/orchestratorModel.ts'

type RunStatus =
  | 'requirements'
  | 'llm-approval'
  | 'running'
  | 'paused'
  | 'waiting-for-human'
  | 'complete'

type OrchestratorRun = {
  id: string
  featureRequest: string
  requirements: RequirementsState
  branchName: string
  currentStepIndex: number
  mergeApproved: boolean
  prodApproved: boolean
  isRunning: boolean
  createdAt: string
  updatedAt: string
  logEntries: LogEntry[]
  artifacts: AgentArtifact[]
  peerReviews: PeerReview[]
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
const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-4.1-mini'
const openaiClient = process.env.OPENAI_API_KEY ? new OpenAI() : null
const requireLlmApproval = process.env.LLM_REQUIRE_APPROVAL !== 'false'
const llmMaxOutputTokens = parsePositiveInteger(process.env.LLM_MAX_OUTPUT_TOKENS, 300)

const modelPricingUsdPerMillion: Record<string, { input: number; output: number }> = {
  'gpt-4.1-mini': { input: 0.4, output: 1.6 },
}

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
    'You are the DevOps agent. Produce repository, pull request, deployment, environment, rollback, and release-control handoffs. Respect human approval gates.',
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

const getLlmProvider = (): LlmProviderStatus => ({
  mode: openaiClient ? 'openai' : 'mock',
  model: openaiClient ? openaiModel : 'mock-local-persona',
  configured: Boolean(openaiClient),
})

const estimateTokens = (value: string) => Math.ceil(value.length / 4)

const estimateCost = (inputTokens: number, outputTokens: number) => {
  const pricing = modelPricingUsdPerMillion[openaiModel] ?? modelPricingUsdPerMillion['gpt-4.1-mini']
  const estimatedInputCostUsd = (inputTokens / 1_000_000) * pricing.input
  const estimatedOutputCostUsd = (outputTokens / 1_000_000) * pricing.output

  return {
    estimatedInputCostUsd,
    estimatedOutputCostUsd,
    estimatedTotalCostUsd: estimatedInputCostUsd + estimatedOutputCostUsd,
  }
}

const makePendingLlmCall = (
  kind: PendingLlmCall['kind'],
  title: string,
  description: string,
  inputText: string,
  outputTokenMultiplier = 1,
): PendingLlmCall => {
  const estimatedInputTokens = estimateTokens(inputText)
  const maxOutputTokens = llmMaxOutputTokens * outputTokenMultiplier
  const costs = estimateCost(estimatedInputTokens, maxOutputTokens)

  return {
    id: createId(),
    kind,
    title,
    description,
    model: openaiModel,
    estimatedInputTokens,
    maxOutputTokens,
    ...costs,
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

  return [
    '# Baseline Requirements Document',
    '',
    `## Feature`,
    run.featureRequest,
    '',
    '## User And Business Context',
    answers || 'Captured through the BA clarification chat.',
    '',
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

const createOpenAIBaDecision = async (
  run: OrchestratorRun,
  forceMock = false,
): Promise<BaRequirementDecision> => {
  if (forceMock || !openaiClient) return createMockBaDecision(run)

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

  const response = await openaiClient.responses.create({
    model: openaiModel,
    instructions: personaPrompts['Business analyst agent'],
    input: buildBaRequirementInput(run),
    max_output_tokens: llmMaxOutputTokens,
  })

  return parseBaDecision(response.output_text)
}

const createRequirementsArtifact = (
  run: OrchestratorRun,
  requirementsDocument: string,
  provider: AgentArtifact['provider'],
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
  provider,
  model: provider === 'openai' ? openaiModel : 'mock-local-persona',
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

    if (
      openaiClient &&
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
          input,
        ),
      )
      return
    }

    run.pendingLlmCall = undefined
    const decision = await createOpenAIBaDecision(run, options.forceMock)

    if (decision.status === 'complete' && decision.requirementsDocument) {
      const artifact = createRequirementsArtifact(
        run,
        decision.requirementsDocument,
        options.forceMock || !openaiClient ? 'mock' : 'openai',
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
      const artifact = createRequirementsArtifact(run, fallback.requirementsDocument, 'mock')
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

  return [
    `Feature request: ${run.featureRequest}`,
    `Branch: ${run.branchName}`,
    `Current step: ${step.label}`,
    `Environment: ${step.environment}`,
    `Step objective: ${step.detail}`,
    `Assigned persona: ${agentName}`,
    `Specialization: ${agent.specialization}`,
    `Review responsibility: ${agent.reviewLens}`,
    '',
    getBaselineContextFile(run),
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
  const output = [
    `### Deliverable`,
    `${persona} prepared the local handoff for ${step.label.toLowerCase()} against "${run.featureRequest}".`,
    '',
    `### Evidence`,
    baseline
      ? `Used baseline-requirements.md from ${baseline.title} as the shared context file.`
      : `Used the feature request as context because the baseline document is not ready yet.`,
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

const createOpenAIArtifact = async (
  run: OrchestratorRun,
  step: WorkflowStep,
  agentName: AgentName,
  forceMock = false,
): Promise<AgentArtifact> => {
  if (forceMock || !openaiClient) return createMockArtifact(run, step, agentName)

  const response = await openaiClient.responses.create({
    model: openaiModel,
    instructions: personaPrompts[agentName],
    input: buildAgentInput(run, step, agentName),
    max_output_tokens: llmMaxOutputTokens,
  })

  const output = response.output_text.trim()
  const persona = agentName.replace(' agent', '')

  return {
    id: createId(),
    stepId: step.id,
    stepLabel: step.label,
    agentName,
    title: `${persona} handoff`,
    summary: firstSentence(output),
    output,
    provider: 'openai',
    model: openaiModel,
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
    (reviewerAgent === 'Architect agent' && ['user-stories', 'developer-handoff', 'build-code'].includes(step.id)) ||
    (reviewerAgent === 'Tester agent' && ['architecture-design', 'user-stories', 'developer-handoff', 'build-code', 'pull-request'].includes(step.id)) ||
    (reviewerAgent === 'DevOps agent' && ['architecture-design', 'developer-handoff', 'check-in', 'pull-request', 'deploy-stage'].includes(step.id)) ||
    (reviewerAgent === 'Software agent' && ['architecture-design', 'user-stories', 'qa-code', 'deploy-stage', 'deploy-prod'].includes(step.id))
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
      artifacts.push(await createOpenAIArtifact(run, step, agentName, forceMock))
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
  const waitingForMerge =
    Boolean(currentStep?.gate === 'merge') && !run.mergeApproved
  const waitingForProd =
    Boolean(currentStep?.gate === 'prod') && !run.prodApproved
  const isWaiting =
    !isComplete &&
    (waitingForLlmApproval || waitingForRequirements || waitingForMerge || waitingForProd)
  const progress = Math.round(
    (Math.min(run.currentStepIndex, WORKFLOW.length) / WORKFLOW.length) * 100,
  )
  const status: RunStatus = isComplete
    ? 'complete'
    : waitingForLlmApproval
      ? 'llm-approval'
    : waitingForRequirements
      ? 'requirements'
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
    waitingForMerge,
    waitingForProd,
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

const buildAgentStepApprovalInput = (run: OrchestratorRun, step: WorkflowStep) =>
  step.agents
    .map(
      (agentName) =>
        `${personaPrompts[agentName]}\n\n${buildAgentInput(run, step, agentName)}`,
    )
    .join('\n\n---\n\n')

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

    if (
      openaiClient &&
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
          buildAgentStepApprovalInput(run, step),
          step.agents.length,
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

app.post('/api/runs', async (request, response) => {
  const featureRequest =
    typeof request.body?.featureRequest === 'string'
      ? request.body.featureRequest.trim()
      : ''

  if (!featureRequest) {
    response.status(400).json({ error: 'featureRequest is required.' })
    return
  }

  if (activeRunId) clearRunTimer(activeRunId)

  const slug = slugify(featureRequest) || 'new-local-work-item'
  const run: OrchestratorRun = {
    id: createId(),
    featureRequest,
    requirements: {
      status: 'clarifying',
      messages: [makeRequirementMessage('user', featureRequest)],
    },
    branchName: `feature/${slug}`,
    currentStepIndex: 0,
    mergeApproved: false,
    prodApproved: false,
    isRunning: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifacts: [],
    peerReviews: [],
    logEntries: [
      makeLogEntry('User request', featureRequest),
      makeLogEntry(
        'Orchestrator',
        'Run started. Business analyst agent is gathering requirements.',
        'success',
      ),
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
    appendLog(run, 'Human reviewer', 'Pull request manually merged into main.', 'success')
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

app.listen(port, host, () => {
  console.log(`Agent orchestrator API listening on http://${host}:${port}`)
})
