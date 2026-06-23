import cors from 'cors'
import express from 'express'
import {
  AGENTS,
  ENVIRONMENTS,
  WORKFLOW,
  slugify,
  type GateType,
  type LogEntry,
  type Tone,
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
}

const app = express()
const host = process.env.API_HOST ?? '127.0.0.1'
const port = Number(process.env.API_PORT ?? 3001)
const stepDurationMs = Number(process.env.STEP_DURATION_MS ?? 1300)

const runs = new Map<string, OrchestratorRun>()
const timers = new Map<string, NodeJS.Timeout>()
let activeRunId: string | null = null

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

const completeActiveStep = (runId: string) => {
  const run = runs.get(runId)
  if (!run) return

  clearRunTimer(runId)
  const flags = getRunFlags(run)
  if (!run.isRunning || flags.isWaiting || flags.isComplete) return

  const step = getCurrentStep(run)
  if (!step) return

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
}

const scheduleRun = (runId: string) => {
  const run = runs.get(runId)
  if (!run) return

  clearRunTimer(runId)
  const flags = getRunFlags(run)
  if (!run.isRunning || flags.isWaiting || flags.isComplete) return

  timers.set(
    runId,
    setTimeout(() => completeActiveStep(runId), stepDurationMs),
  )
}

const notFound = { error: 'Run not found.' }

app.get('/health', (_request, response) => {
  response.json({
    status: 'ok',
    service: 'agent-delivery-orchestrator-api',
    activeRunId,
    workflowSteps: WORKFLOW.length,
  })
})

app.get('/api/workflow', (_request, response) => {
  response.json({
    workflow: WORKFLOW,
    agents: AGENTS,
    environments: ENVIRONMENTS,
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
