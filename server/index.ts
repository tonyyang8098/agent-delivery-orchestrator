import 'dotenv/config'
import cors from 'cors'
import express from 'express'
import OpenAI from 'openai'
import {
  AGENTS,
  ENVIRONMENTS,
  WORKFLOW,
  slugify,
  type AgentArtifact,
  type AgentName,
  type GateType,
  type LlmProviderStatus,
  type LogEntry,
  type RequirementChatMessage,
  type RequirementsState,
  type Tone,
  type WorkflowStep,
} from '../src/orchestratorModel.ts'

type RunStatus =
  | 'requirements'
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
}

const app = express()
const host = process.env.API_HOST ?? '127.0.0.1'
const port = Number(process.env.API_PORT ?? 3001)
const stepDurationMs = Number(process.env.STEP_DURATION_MS ?? 1300)
const openaiModel = process.env.OPENAI_MODEL ?? 'gpt-5.5'
const openaiClient = process.env.OPENAI_API_KEY ? new OpenAI() : null

const runs = new Map<string, OrchestratorRun>()
const timers = new Map<string, NodeJS.Timeout>()
const inFlightSteps = new Set<string>()
let activeRunId: string | null = null

const personaPrompts: Record<AgentName, string> = {
  'Business analyst agent':
    'You are the Business Analyst agent. You interview the user until requirements are complete, then create a baseline requirements document for developer handoff. Ask one clear question at a time. Be precise and practical.',
  'Software agent':
    'You are the Software agent. Produce implementation notes, code design, branch-ready tasks, and engineering tradeoffs. Be concrete and avoid vague architecture language.',
  'Tester agent':
    'You are the Tester agent. Produce QA strategy, acceptance coverage, regression risks, and test evidence. Think about failure modes and environment-specific checks.',
  'DevOps agent':
    'You are the DevOps agent. Produce repository, pull request, deployment, environment, rollback, and release-control handoffs. Respect human approval gates.',
}

app.use(cors({ origin: ['http://127.0.0.1:5173', 'http://localhost:5173'] }))
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
  const answers = run.requirements.messages
    .filter((message) => message.role === 'user')
    .slice(1)
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
  const userAnswerCount = run.requirements.messages.filter(
    (message) => message.role === 'user',
  ).length - 1

  if (userAnswerCount < mockQuestions.length) {
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

const buildBaRequirementInput = (run: OrchestratorRun) => {
  const transcript = run.requirements.messages
    .map((message) => `${message.role === 'ba' ? 'BA' : 'User'}: ${message.content}`)
    .join('\n')

  return [
    `Feature request: ${run.featureRequest}`,
    '',
    'Requirement interview transcript:',
    transcript || 'No transcript yet.',
    '',
    'Decide whether requirements are complete enough to hand off to developer agents.',
    'If any material requirement is missing, return exactly one clarifying question.',
    'Prioritize these gaps: users/personas, business outcome, scope boundaries, workflows, data, rules, integrations, audit/security, acceptance criteria, edge cases, and deployment constraints.',
    '',
    'Return JSON only with one of these shapes:',
    '{"status":"clarifying","question":"one concise question","summary":"short reason"}',
    '{"status":"complete","requirementsDocument":"markdown baseline requirements document","summary":"short handoff summary"}',
  ].join('\n')
}

const createOpenAIBaDecision = async (
  run: OrchestratorRun,
): Promise<BaRequirementDecision> => {
  if (!openaiClient) return createMockBaDecision(run)

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
  })

  return parseBaDecision(response.output_text)
}

const createRequirementsArtifact = (
  requirementsDocument: string,
  provider: AgentArtifact['provider'],
): AgentArtifact => ({
  id: createId(),
  stepId: 'intake',
  stepLabel: 'Feature intake',
  agentName: 'Business analyst agent',
  title: 'Baseline requirements document',
  summary: firstSentence(requirementsDocument),
  output: requirementsDocument,
  provider,
  model: provider === 'openai' ? openaiModel : 'mock-local-persona',
  createdAt: new Date().toISOString(),
})

const continueBaRequirements = async (run: OrchestratorRun) => {
  try {
    const decision = await createOpenAIBaDecision(run)

    if (decision.status === 'complete' && decision.requirementsDocument) {
      const artifact = createRequirementsArtifact(
        decision.requirementsDocument,
        openaiClient ? 'openai' : 'mock',
      )
      run.artifacts = [...run.artifacts, artifact]
      run.requirements.status = 'complete'
      run.requirements.baselineArtifactId = artifact.id
      run.currentStepIndex = 1
      run.isRunning = true
      appendLog(
        run,
        'Business analyst agent',
        'Baseline requirements document created and handed off to developer agents.',
        'success',
      )
      scheduleRun(run.id)
      return
    }

    const question =
      decision.question ??
      'What acceptance criteria should determine whether this feature is ready for handoff?'
    run.requirements.messages.push(makeRequirementMessage('ba', question))
    appendLog(run, 'Business analyst agent', 'Clarifying question sent to the user.')
  } catch (error) {
    const fallback = createMockBaDecision(run)
    if (fallback.status === 'complete' && fallback.requirementsDocument) {
      const artifact = createRequirementsArtifact(fallback.requirementsDocument, 'mock')
      artifact.summary =
        error instanceof Error
          ? `LLM requirement analysis failed: ${error.message}. Mock baseline generated.`
          : 'LLM requirement analysis failed. Mock baseline generated.'
      run.artifacts = [...run.artifacts, artifact]
      run.requirements.status = 'complete'
      run.requirements.baselineArtifactId = artifact.id
      run.currentStepIndex = 1
      run.isRunning = true
      appendLog(
        run,
        'Business analyst agent',
        'Mock baseline requirements document created after LLM fallback.',
        'warning',
      )
      scheduleRun(run.id)
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
    priorArtifacts ? `Recent handoffs:\n${priorArtifacts}` : 'Recent handoffs: none',
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
  const output = [
    `### Deliverable`,
    `${persona} prepared the local handoff for ${step.label.toLowerCase()} against "${run.featureRequest}".`,
    '',
    `### Evidence`,
    `The workflow advanced through ${step.environment} with simulated evidence for ${step.agents.join(', ')}.`,
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
): Promise<AgentArtifact> => {
  if (!openaiClient) return createMockArtifact(run, step, agentName)

  const response = await openaiClient.responses.create({
    model: openaiModel,
    instructions: personaPrompts[agentName],
    input: buildAgentInput(run, step, agentName),
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

const createAgentArtifacts = async (
  run: OrchestratorRun,
  step: WorkflowStep,
) => {
  const artifacts: AgentArtifact[] = []

  for (const agentName of step.agents) {
    try {
      artifacts.push(await createOpenAIArtifact(run, step, agentName))
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
}

const getActiveRun = () =>
  activeRunId ? runs.get(activeRunId) ?? null : null

const getCurrentStep = (run: OrchestratorRun) => WORKFLOW[run.currentStepIndex]

const getRunFlags = (run: OrchestratorRun) => {
  const currentStep = getCurrentStep(run)
  const isComplete = run.currentStepIndex >= WORKFLOW.length
  const waitingForRequirements = run.requirements.status === 'clarifying'
  const waitingForMerge =
    Boolean(currentStep?.gate === 'merge') && !run.mergeApproved
  const waitingForProd =
    Boolean(currentStep?.gate === 'prod') && !run.prodApproved
  const isWaiting =
    !isComplete && (waitingForRequirements || waitingForMerge || waitingForProd)
  const progress = Math.round(
    (Math.min(run.currentStepIndex, WORKFLOW.length) / WORKFLOW.length) * 100,
  )
  const status: RunStatus = isComplete
    ? 'complete'
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

const completeActiveStep = async (runId: string) => {
  const run = runs.get(runId)
  if (!run) return

  clearRunTimer(runId)
  if (inFlightSteps.has(runId)) return
  inFlightSteps.add(runId)

  try {
    const flags = getRunFlags(run)
    if (!run.isRunning || flags.isWaiting || flags.isComplete) return

    const step = getCurrentStep(run)
    if (!step) return

    appendLog(
      run,
      'LLM provider',
      `Running ${step.agents.join(' + ')} with ${getLlmProvider().mode} provider.`,
    )
    await createAgentArtifacts(run, step)

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
  })
})

app.get('/api/workflow', (_request, response) => {
  response.json({
    workflow: WORKFLOW,
    agents: AGENTS,
    environments: ENVIRONMENTS,
    llmProvider: getLlmProvider(),
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

  if (run.requirements.status === 'complete') {
    response.status(409).json({ error: 'Requirements are already complete.' })
    return
  }

  const message =
    typeof request.body?.message === 'string' ? request.body.message.trim() : ''
  if (!message) {
    response.status(400).json({ error: 'message is required.' })
    return
  }

  run.requirements.messages.push(makeRequirementMessage('user', message))
  appendLog(run, 'User', 'Requirement clarification answered.')
  await continueBaRequirements(run)

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
