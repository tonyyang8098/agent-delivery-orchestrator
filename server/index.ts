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
  type Tone,
  type WorkflowStep,
} from '../src/orchestratorModel.ts'

type RunStatus = 'running' | 'paused' | 'waiting-for-human' | 'complete'

type OrchestratorRun = {
  id: string
  featureRequest: string
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
    'You are the Business Analyst agent. Convert user intent into clear scope, acceptance criteria, release notes, and business risk. Be precise and practical.',
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

const getLlmProvider = (): LlmProviderStatus => ({
  mode: openaiClient ? 'openai' : 'mock',
  model: openaiClient ? openaiModel : 'mock-local-persona',
  configured: Boolean(openaiClient),
})

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
  const waitingForMerge =
    Boolean(currentStep?.gate === 'merge') && !run.mergeApproved
  const waitingForProd =
    Boolean(currentStep?.gate === 'prod') && !run.prodApproved
  const isWaiting = !isComplete && (waitingForMerge || waitingForProd)
  const progress = Math.round(
    (Math.min(run.currentStepIndex, WORKFLOW.length) / WORKFLOW.length) * 100,
  )
  const status: RunStatus = isComplete
    ? 'complete'
    : isWaiting
      ? 'waiting-for-human'
      : run.isRunning
        ? 'running'
        : 'paused'

  return {
    currentStep,
    isComplete,
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

app.post('/api/runs', (request, response) => {
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
    branchName: `feature/${slug}`,
    currentStepIndex: 0,
    mergeApproved: false,
    prodApproved: false,
    isRunning: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    artifacts: [],
    logEntries: [
      makeLogEntry('User request', featureRequest),
      makeLogEntry(
        'Orchestrator',
        'Run started. Business analyst agent is taking intake.',
        'success',
      ),
    ],
  }

  runs.set(run.id, run)
  activeRunId = run.id
  scheduleRun(run.id)

  response.status(201).json({ run: serializeRun(run) })
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
