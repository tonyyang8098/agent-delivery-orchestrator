import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  BadgeDollarSign,
  Boxes,
  Bug,
  CheckCircle2,
  Circle,
  ClipboardCheck,
  Code2,
  FileCheck2,
  FileText,
  GitBranch,
  GitMerge,
  GitPullRequest,
  LockKeyhole,
  MessageSquareText,
  Pause,
  Play,
  RefreshCcw,
  Rocket,
  SendHorizontal,
  Server,
  ShieldCheck,
  Terminal,
  UserCheck,
  UsersRound,
  Wrench,
} from 'lucide-react'
import {
  AGENTS,
  ENVIRONMENTS,
  ENVIRONMENT_BRANCHES,
  WORKFLOW,
  slugify,
  type AgentContextPack,
  type AgentArtifact,
  type AgentMemory,
  type ContextSummary,
  type DecisionTraceEntry,
  type DeploymentAccessBlocker,
  type EnvironmentBranch,
  type AgentName,
  type GateType,
  type LlmProviderStatus,
  type LogEntry,
  type PendingLlmCall,
  type PeerReview,
  type RequirementsState,
  type StepState,
  type UploadedContextFile,
  type WorkflowStep,
} from './orchestratorModel'
import './App.css'

type ApiStatus = 'checking' | 'online' | 'offline'
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
  branchName: string
  environmentBranches: EnvironmentBranch[]
  currentStepIndex: number
  mergeApproved: boolean
  prodApproved: boolean
  isRunning: boolean
  createdAt: string
  updatedAt: string
  requirements: RequirementsState
  logEntries: LogEntry[]
  currentStep?: WorkflowStep
  isComplete: boolean
  waitingForLlmApproval: boolean
  waitingForRequirements: boolean
  waitingForAccess: boolean
  waitingForMerge: boolean
  waitingForProd: boolean
  isWaiting: boolean
  progress: number
  status: RunStatus
  artifacts: AgentArtifact[]
  peerReviews: PeerReview[]
  accessBlockers: DeploymentAccessBlocker[]
  activeAccessBlocker?: DeploymentAccessBlocker
  contextSummary: ContextSummary
  contextPacks: AgentContextPack[]
  decisionTrace: DecisionTraceEntry[]
  agentMemory: AgentMemory[]
  contextFiles: UploadedContextFile[]
  llmProvider: LlmProviderStatus
  pendingLlmCall?: PendingLlmCall
}

type RunResponse = {
  run: OrchestratorRun | null
}

type HealthResponse = {
  llmProvider: LlmProviderStatus
  agentMemory: AgentMemory[]
}

type ApiErrorResponse = {
  error?: string
}

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001'

const defaultRequest =
  'Build a customer onboarding checklist with role-based approval and audit history.'

const defaultProjectName = 'Customer Onboarding Platform'

const defaultLogEntries: LogEntry[] = [
  {
    id: 'local-ready',
    at: '--:--:--',
    actor: 'Orchestrator',
    message: 'Local control plane is ready.',
    tone: 'info',
  },
]

const workflowIcons: Record<string, LucideIcon> = {
  intake: ClipboardCheck,
  'solution-plan': Boxes,
  'design-and-stories': Boxes,
  'developer-handoff': ClipboardCheck,
  'build-code': Code2,
  'qa-code': Bug,
  'check-in': GitBranch,
  'pull-request': GitPullRequest,
  'human-merge': GitMerge,
  'deploy-dev': Server,
  'deploy-stage': Rocket,
  'prod-approval': LockKeyhole,
  'deploy-prod': ShieldCheck,
}

const agentIcons: Record<AgentName, LucideIcon> = {
  'Business analyst agent': UsersRound,
  'Architect agent': Boxes,
  'Software agent': Code2,
  'Tester agent': Bug,
  'DevOps agent': Terminal,
}

const readinessChecks: Array<[string, string, LucideIcon]> = [
  ['Design/stories', 'design-and-stories', Boxes],
  ['Build', 'build-code', Wrench],
  ['QA', 'qa-code', Bug],
  ['Check in', 'check-in', FileCheck2],
  ['Pull request', 'pull-request', GitPullRequest],
]

const processingStages: Array<{
  label: string
  detail: string
  stepIds: string[]
  Icon: LucideIcon
}> = [
  {
    label: 'Clarify',
    detail: 'BA baseline',
    stepIds: ['intake'],
    Icon: MessageSquareText,
  },
  {
    label: 'Design',
    detail: 'Architecture and stories',
    stepIds: ['design-and-stories', 'developer-handoff'],
    Icon: Boxes,
  },
  {
    label: 'Build',
    detail: 'Code and check in',
    stepIds: ['build-code', 'check-in'],
    Icon: Code2,
  },
  {
    label: 'Verify',
    detail: 'QA and PR review',
    stepIds: ['qa-code', 'pull-request', 'human-merge'],
    Icon: ClipboardCheck,
  },
  {
    label: 'Release',
    detail: 'Dev, stage, prod',
    stepIds: ['deploy-dev', 'deploy-stage', 'prod-approval', 'deploy-prod'],
    Icon: Rocket,
  },
]

const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const requestApi = async <T,>(path: string, options: RequestInit = {}) => {
  const isFormData = options.body instanceof FormData
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      ...(isFormData ? {} : { 'Content-Type': 'application/json' }),
      ...options.headers,
    },
  })

  if (!response.ok) {
    const errorBody = (await response
      .json()
      .catch(() => ({}))) as ApiErrorResponse
    throw new Error(errorBody.error ?? `API request failed with ${response.status}.`)
  }

  return (await response.json()) as T
}

function App() {
  const [projectName, setProjectName] = useState(defaultProjectName)
  const [featureRequest, setFeatureRequest] = useState(defaultRequest)
  const [run, setRun] = useState<OrchestratorRun | null>(null)
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking')
  const [apiError, setApiError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [requirementAnswer, setRequirementAnswer] = useState('')
  const [selectedContextFiles, setSelectedContextFiles] = useState<File[]>([])
  const [llmProvider, setLlmProvider] = useState<LlmProviderStatus>({
    mode: 'mock',
    model: 'mock-local-persona',
    configured: false,
    routes: [],
  })
  const [agentMemory, setAgentMemory] = useState<AgentMemory[]>([])

  const runStarted = Boolean(run)
  const currentStepIndex = run?.currentStepIndex ?? 0
  const currentStep = WORKFLOW[currentStepIndex]
  const isComplete = Boolean(run?.isComplete)
  const waitingForLlmApproval = Boolean(run?.waitingForLlmApproval)
  const waitingForRequirements = Boolean(run?.waitingForRequirements)
  const waitingForAccess = Boolean(run?.waitingForAccess)
  const waitingForMerge = Boolean(run?.waitingForMerge)
  const waitingForProd = Boolean(run?.waitingForProd)
  const isWaiting = Boolean(run?.isWaiting)
  const isRunning = Boolean(run?.isRunning)
  const mergeApproved = Boolean(run?.mergeApproved)
  const prodApproved = Boolean(run?.prodApproved)
  const progress = run?.progress ?? 0
  const logEntries = run?.logEntries ?? defaultLogEntries
  const artifacts = run?.artifacts ?? []
  const peerReviews = run?.peerReviews ?? []
  const contextFiles = run?.contextFiles ?? []
  const contextSummary = run?.contextSummary
  const contextPacks = run?.contextPacks ?? []
  const decisionTrace = run?.decisionTrace ?? []
  const environmentBranches = run?.environmentBranches ?? ENVIRONMENT_BRANCHES
  const pendingLlmCall = run?.pendingLlmCall
  const activeAccessBlocker = run?.activeAccessBlocker
  const requirementMessages = run?.requirements.messages ?? []
  const baselineRequirement = run?.requirements.baselineArtifactId
    ? artifacts.find((artifact) => artifact.id === run.requirements.baselineArtifactId)
    : undefined
  const hasRunInput = Boolean(featureRequest.trim() || selectedContextFiles.length > 0)
  const canSendRequirementMessage =
    runStarted && apiStatus === 'online' && !isSubmitting && !waitingForLlmApproval
  const repositoryName =
    run?.repositoryName || slugify(projectName) || 'local-delivery-project'

  const branchName = useMemo(() => {
    if (run?.branchName) return run.branchName

    const slug = slugify(featureRequest) || 'new-local-work-item'
    return `feature/${slug}`
  }, [featureRequest, run?.branchName])

  const loadActiveRun = useCallback(async () => {
    try {
      const health = await requestApi<HealthResponse>('/health')
      const response = await requestApi<RunResponse>('/api/runs/active')
      setApiStatus('online')
      setApiError(null)
      setLlmProvider(response.run?.llmProvider ?? health.llmProvider)
      setAgentMemory(response.run?.agentMemory ?? health.agentMemory ?? [])
      setRun(response.run)
      if (response.run) {
        setProjectName(response.run.projectName)
        setFeatureRequest(response.run.featureRequest)
      }
    } catch (error) {
      setApiStatus('offline')
      setApiError(
        error instanceof Error
          ? `${error.message} Start the backend with npm run api.`
          : 'Backend API is offline. Start it with npm run api.',
      )
    }
  }, [])

  useEffect(() => {
    const initialLoad = window.setTimeout(() => {
      void loadActiveRun()
    }, 0)
    const interval = window.setInterval(() => {
      void loadActiveRun()
    }, 1000)

    return () => {
      window.clearTimeout(initialLoad)
      window.clearInterval(interval)
    }
  }, [loadActiveRun])

  const applyRunResponse = (response: RunResponse) => {
    setRun(response.run)
    if (response.run?.llmProvider) setLlmProvider(response.run.llmProvider)
    if (response.run?.agentMemory) setAgentMemory(response.run.agentMemory)
    if (response.run) {
      setProjectName(response.run.projectName)
      setFeatureRequest(response.run.featureRequest)
      setSelectedContextFiles([])
    }
    setApiError(null)
  }

  const mutateRun = async (operation: () => Promise<RunResponse>) => {
    setIsSubmitting(true)
    try {
      const response = await operation()
      applyRunResponse(response)
      setApiStatus('online')
    } catch (error) {
      setApiError(error instanceof Error ? error.message : 'API request failed.')
      if (error instanceof TypeError) setApiStatus('offline')
    } finally {
      setIsSubmitting(false)
    }
  }

  const getStepState = (index: number): StepState => {
    if (!runStarted) return 'pending'
    if (index < currentStepIndex) return 'complete'
    if (index > currentStepIndex || isComplete) return 'pending'
    if (waitingForLlmApproval) return 'waiting'
    if (index === 0 && waitingForRequirements) return 'waiting'
    if (waitingForAccess && index === currentStepIndex) return 'waiting'
    if (WORKFLOW[index].gate && isWaiting) return 'waiting'
    return 'active'
  }

  const startRun = () => {
    const trimmedRequest = featureRequest.trim()
    if (!trimmedRequest && selectedContextFiles.length === 0) return

    const body = new FormData()
    body.append('projectName', projectName.trim())
    body.append('featureRequest', trimmedRequest)
    selectedContextFiles.forEach((file) => {
      body.append('contextFiles', file)
    })

    void mutateRun(() =>
      requestApi<RunResponse>('/api/runs', {
        method: 'POST',
        body,
      }),
    )
  }

  const sendRequirementAnswer = () => {
    if (!run || !requirementAnswer.trim()) return

    const message = requirementAnswer.trim()
    void mutateRun(() =>
      requestApi<RunResponse>(`/api/runs/${run.id}/requirements/messages`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      }).then((response) => {
        setRequirementAnswer('')
        return response
      }),
    )
  }

  const approveLlmCall = () => {
    if (!run) return

    void mutateRun(() =>
      requestApi<RunResponse>(`/api/runs/${run.id}/llm/approve`, {
        method: 'POST',
      }),
    )
  }

  const useMockForLlmCall = () => {
    if (!run) return

    void mutateRun(() =>
      requestApi<RunResponse>(`/api/runs/${run.id}/llm/mock`, {
        method: 'POST',
      }),
    )
  }

  const resetRun = () => {
    if (!run) {
      setProjectName(defaultProjectName)
      setFeatureRequest(defaultRequest)
      setApiError(null)
      setSelectedContextFiles([])
      return
    }

    void mutateRun(() =>
      requestApi<RunResponse>(`/api/runs/${run.id}/reset`, {
        method: 'POST',
      }),
    )
  }

  const approveGate = (gate: GateType) => {
    if (!run) return

    void mutateRun(() =>
      requestApi<RunResponse>(`/api/runs/${run.id}/approvals/${gate}`, {
        method: 'POST',
      }),
    )
  }

  const verifyAccessBlocker = () => {
    if (!run || !activeAccessBlocker) return

    void mutateRun(() =>
      requestApi<RunResponse>(`/api/runs/${run.id}/access/verify`, {
        method: 'POST',
        body: JSON.stringify({
          evidence: `${activeAccessBlocker.environment} access setup confirmed by human operator.`,
        }),
      }),
    )
  }

  const keepAccessBlockerOpen = () => {
    if (!run || !activeAccessBlocker) return

    void mutateRun(() =>
      requestApi<RunResponse>(`/api/runs/${run.id}/access/still-blocked`, {
        method: 'POST',
        body: JSON.stringify({
          evidence: `${activeAccessBlocker.environment} access remains unresolved.`,
        }),
      }),
    )
  }

  const toggleRunning = () => {
    if (!runStarted) {
      startRun()
      return
    }

    if (!run || isComplete || isWaiting) return

    const action = isRunning ? 'pause' : 'resume'
    void mutateRun(() =>
      requestApi<RunResponse>(`/api/runs/${run.id}/${action}`, {
        method: 'POST',
      }),
    )
  }

  const getAgentState = (agentName: AgentName) => {
    const indexes = WORKFLOW.flatMap((step, index) =>
      step.agents.includes(agentName) ? [index] : [],
    )
    const firstIndex = indexes[0] ?? Number.POSITIVE_INFINITY
    const lastIndex = indexes[indexes.length - 1] ?? -1
    const isAssignedNow = Boolean(currentStep?.agents.includes(agentName))

    if (!runStarted) return 'Idle'
    if (isAssignedNow && waitingForRequirements) return 'Interviewing'
    if (isAssignedNow && isWaiting) return 'Waiting'
    if (isAssignedNow) return 'Working'
    if (currentStepIndex > lastIndex) return 'Complete'
    if (currentStepIndex > firstIndex) return 'Standing by'
    return 'Queued'
  }

  const getAgentFocus = (agent: (typeof AGENTS)[number]) => {
    if (currentStep?.agents.includes(agent.name)) {
      if (waitingForRequirements) return 'Interviewing the user for complete requirements.'
      if (waitingForAccess) return 'Waiting for scoped AWS/Azure access verification.'
      return isWaiting ? 'Blocked on a human gate.' : currentStep.detail
    }
    return getAgentState(agent.name) === 'Complete'
      ? 'Assigned workflow is complete.'
      : agent.mission
  }

  const getAgentMemory = (agentName: AgentName) =>
    agentMemory.find((memory) => memory.agentName === agentName)

  const latestPeerReviews = peerReviews.slice(-6).reverse()
  const latestDecisionTrace = decisionTrace.slice(-6).reverse()
  const activeContextPacks = contextPacks.filter((pack) =>
    currentStep?.agents.includes(pack.agentName),
  )

  const environmentStatus = (stepId: string, envName: string) => {
    const deployIndex = WORKFLOW.findIndex((step) => step.id === stepId)

    if (!runStarted) return 'Ready'
    if (currentStep?.id === stepId && waitingForAccess) return 'Access blocked'
    if (currentStep?.id === stepId) return 'Deploying'
    if (currentStepIndex > deployIndex) return 'Live'
    if (envName === 'Prod' && waitingForProd) return 'Approval required'
    return 'Queued'
  }

  const checkStatus = (stepId: string) => {
    const index = WORKFLOW.findIndex((step) => step.id === stepId)
    if (!runStarted) return 'Queued'
    if (currentStepIndex > index) return 'Passed'
    if (currentStepIndex === index && !isWaiting) return 'Running'
    return 'Queued'
  }

  const getProcessingStageState = (
    stage: (typeof processingStages)[number],
  ): StepState => {
    if (isComplete) return 'complete'
    if (!runStarted) return 'pending'
    if (currentStep && stage.stepIds.includes(currentStep.id)) {
      return isWaiting ? 'waiting' : 'active'
    }

    const stageIndexes = stage.stepIds
      .map((stepId) => WORKFLOW.findIndex((step) => step.id === stepId))
      .filter((index) => index >= 0)
    const lastIndex = Math.max(...stageIndexes)
    return currentStepIndex > lastIndex ? 'complete' : 'pending'
  }

  const processingMessage = isComplete
    ? 'Production release is complete and agent artifacts are ready for review.'
    : waitingForLlmApproval
      ? `${pendingLlmCall?.model ?? 'The paid model'} is waiting for explicit spend approval.`
    : waitingForRequirements
      ? baselineRequirement
        ? 'BA is reviewing the requested scope change against the current baseline.'
        : 'BA is interviewing for a complete baseline before developer work starts.'
    : waitingForAccess
      ? 'DevOps is paused until scoped AWS/Azure access is verified by the human operator.'
    : isWaiting
      ? 'The workflow is parked at a human control gate.'
    : runStarted && isRunning
      ? `${currentStep?.agents.map((agent) => agent.replace(' agent', '')).join(' + ') ?? 'Agents'} are working on ${currentStep?.label.toLowerCase() ?? 'the workflow'}.`
    : runStarted
      ? 'The run is paused. Resume when you want agents to continue.'
      : 'Name the project, describe the feature, then start the local delivery run.'

  return (
    <main className="orchestrator-shell">
      <header className="topbar">
        <div className="brand-title">
          <div className="brand-mark" aria-hidden="true">
            <span>AF</span>
          </div>
          <div>
            <p className="eyebrow">AgentFlow Studio</p>
            <h1>Delivery Orchestrator</h1>
          </div>
        </div>
        <div className="topbar-actions" aria-label="Run controls">
          <span className={`api-status ${apiStatus}`}>API {apiStatus}</span>
          <span className={`api-status ${llmProvider.mode}`}>
            LLM {llmProvider.mode}
          </span>
          <button
            type="button"
            className="primary-action"
            onClick={runStarted ? toggleRunning : startRun}
            disabled={
              !hasRunInput ||
              isComplete ||
              isWaiting ||
              apiStatus !== 'online' ||
              isSubmitting
            }
            title={runStarted && isRunning ? 'Pause run' : 'Start or resume run'}
          >
            {runStarted && isRunning ? <Pause size={18} /> : <Play size={18} />}
            <span>
              {isSubmitting
                ? 'Working'
                : runStarted && isRunning
                  ? 'Pause'
                  : runStarted
                    ? 'Resume'
                    : 'Start'}
            </span>
          </button>
          <button
            type="button"
            className="icon-action"
            onClick={resetRun}
            title="Reset run"
            aria-label="Reset run"
            disabled={isSubmitting}
          >
            <RefreshCcw size={18} />
          </button>
        </div>
      </header>

      <section
        className={`processing-panel ${runStarted && isRunning && !isWaiting ? 'is-processing' : ''}`}
        aria-label="Agent processing visualization"
      >
        <div className="processing-copy">
          <div className="brand-chip">
            <Activity size={16} />
            Local delivery control plane
          </div>
          <h2>From feature idea to production handoff</h2>
          <p>{processingMessage}</p>
          <div className="processing-metrics" aria-label="Run metrics">
            <span>
              Project
              <strong>{repositoryName}</strong>
            </span>
            <span>
              Active step
              <strong>{currentStep?.label ?? 'Draft request'}</strong>
            </span>
            <span>
              Reviews
              <strong>{peerReviews.length}</strong>
            </span>
          </div>
        </div>

        <div className="processing-visual">
          <div className="processing-rail" aria-hidden="true">
            <span />
          </div>
          <div className="stage-map" aria-label="Processing stages">
            {processingStages.map((stage) => {
              const state = getProcessingStageState(stage)
              const Icon = stage.Icon
              return (
                <article className={`stage-node ${state}`} key={stage.label}>
                  <div className="stage-icon">
                    <Icon size={18} />
                  </div>
                  <div>
                    <strong>{stage.label}</strong>
                    <span>{stage.detail}</span>
                  </div>
                </article>
              )
            })}
          </div>
          <div className="agent-network" aria-label="Agent activity network">
            <div className="network-hub">
              <Activity size={18} />
              <span>{runStarted ? currentStep?.label ?? 'Complete' : 'Ready'}</span>
            </div>
            <div className="network-agents">
              {AGENTS.map((agent) => {
                const Icon = agentIcons[agent.name]
                const state = getAgentState(agent.name)
                const isActiveAgent = Boolean(currentStep?.agents.includes(agent.name))
                return (
                  <div
                    className={`network-agent ${isActiveAgent ? 'active' : ''}`}
                    key={agent.name}
                  >
                    <Icon size={16} />
                    <strong>{agent.shortName}</strong>
                    <span>{state}</span>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </section>

      <section className="request-panel" aria-label="Feature request">
        <div className="request-copy">
          <div className="project-fields">
            <label htmlFor="project-name">Project name</label>
            <input
              id="project-name"
              type="text"
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              spellCheck="true"
              disabled={runStarted && !isComplete}
            />
            <span>
              GitHub repository: <strong>{repositoryName}</strong>
            </span>
          </div>
          <label htmlFor="feature-request">Feature or tool request</label>
          <textarea
            id="feature-request"
            value={featureRequest}
            onChange={(event) => setFeatureRequest(event.target.value)}
            rows={3}
            spellCheck="true"
            disabled={runStarted && !isComplete}
          />
          <div className="context-upload">
            <label htmlFor="context-files">Requirement and sample data files</label>
            <input
              id="context-files"
              type="file"
              multiple
              accept=".txt,.md,.markdown,.docx,.csv,.xlsx,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(event) =>
                setSelectedContextFiles(Array.from(event.target.files ?? []))
              }
              disabled={runStarted && !isComplete}
            />
            {selectedContextFiles.length > 0 ? (
              <div className="context-file-list" aria-label="Selected context files">
                {selectedContextFiles.map((file) => (
                  <span key={`${file.name}-${file.size}`}>
                    <FileText size={14} />
                    {file.name}
                    <strong>{formatBytes(file.size)}</strong>
                  </span>
                ))}
              </div>
            ) : null}
            {contextFiles.length > 0 ? (
              <div className="context-file-list attached" aria-label="Attached context files">
                {contextFiles.map((file) => (
                  <span key={file.id}>
                    <FileText size={14} />
                    {file.name}
                    <strong>
                      {file.kind === 'sample-data'
                        ? `${file.rowCount ?? 0} rows`
                        : formatBytes(file.size)}
                    </strong>
                  </span>
                ))}
              </div>
            ) : null}
          </div>
          {apiError ? (
            <p className="api-error" role="status">
              <AlertTriangle size={16} />
              {apiError}
            </p>
          ) : null}
        </div>
        <div className="run-summary" aria-label="Run summary">
          <div>
            <span>Progress</span>
            <strong>{progress}%</strong>
          </div>
          <div>
            <span>Run state</span>
            <strong>
              {isComplete
                ? 'Complete'
                : waitingForLlmApproval
                  ? 'LLM approval'
                : waitingForRequirements
                  ? 'Requirements'
                : waitingForAccess
                  ? 'Access blocker'
                : isWaiting
                  ? 'Human gate'
                  : runStarted && isRunning
                    ? 'Agents running'
                    : runStarted
                      ? 'Paused'
                      : 'Draft'}
            </strong>
          </div>
          <div>
            <span>Repository</span>
            <strong>{repositoryName}</strong>
          </div>
          <div>
            <span>Feature branch</span>
            <strong>{branchName}</strong>
          </div>
        </div>
      </section>

      {pendingLlmCall ? (
        <section className="cost-panel" aria-label="LLM cost approval">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Quota control</p>
              <h2>
                <BadgeDollarSign size={20} />
                Approve LLM spend
              </h2>
            </div>
            <span className="status-pill warning">Approval required</span>
          </div>
          <div className="cost-layout">
            <div>
              <h3>{pendingLlmCall.title}</h3>
              <p>{pendingLlmCall.description}</p>
            </div>
            <div className="cost-metrics">
              <span>
                Model
                <strong>{pendingLlmCall.model}</strong>
              </span>
              <span>
                Est. input
                <strong>{pendingLlmCall.estimatedInputTokens.toLocaleString()} tokens</strong>
              </span>
              <span>
                Max output
                <strong>{pendingLlmCall.maxOutputTokens.toLocaleString()} tokens</strong>
              </span>
              <span>
                Est. total
                <strong>${pendingLlmCall.estimatedTotalCostUsd.toFixed(6)}</strong>
              </span>
            </div>
            <div className="cost-actions">
              <button
                type="button"
                className="primary-action"
                onClick={approveLlmCall}
                disabled={isSubmitting}
              >
                <BadgeDollarSign size={17} />
                Approve LLM call
              </button>
              <button
                type="button"
                className="secondary-action"
                onClick={useMockForLlmCall}
                disabled={isSubmitting}
              >
                Use mock for $0
              </button>
            </div>
          </div>
        </section>
      ) : null}

      <section className="requirements-panel" aria-label="Requirements chat">
        <div className="section-heading compact">
          <div>
            <p className="eyebrow">BA requirements chat</p>
            <h2>Clarify and revise scope</h2>
          </div>
          <span className={`status-pill ${baselineRequirement ? 'success' : waitingForRequirements ? 'warning' : ''}`}>
            {waitingForRequirements
              ? baselineRequirement
                ? 'Revision in review'
                : 'Questions open'
              : baselineRequirement
                ? 'Baseline ready'
                : 'Not started'}
          </span>
        </div>

        <div className="requirements-layout">
          <div className="requirements-chat">
            {requirementMessages.length === 0 ? (
              <article className="requirement-empty">
                <MessageSquareText size={18} />
                Start a run and the Business Analyst agent will begin the requirements interview.
              </article>
            ) : (
              requirementMessages.map((message) => (
                <article className={`requirement-message ${message.role}`} key={message.id}>
                  <strong>{message.role === 'ba' ? 'Business analyst agent' : 'User'}</strong>
                  <p>{message.content}</p>
                </article>
              ))
            )}
          </div>

          <div className="requirements-compose">
            <textarea
              aria-label="Requirement clarification answer"
              value={requirementAnswer}
              onChange={(event) => setRequirementAnswer(event.target.value)}
              placeholder={
                waitingForRequirements
                  ? 'Answer the BA question...'
                  : baselineRequirement
                    ? 'Ask the BA to add, modify, delete, or expand scope...'
                    : 'Requirement chat is available after starting a run.'
              }
              rows={4}
              disabled={!canSendRequirementMessage}
            />
            <button
              type="button"
              className="primary-action"
              onClick={sendRequirementAnswer}
              disabled={!canSendRequirementMessage || !requirementAnswer.trim()}
            >
              <SendHorizontal size={17} />
              {baselineRequirement ? 'Send to BA' : 'Send answer'}
            </button>
          </div>

          <aside className="requirements-baseline">
            <div>
              <h3>
                <FileText size={18} />
                Baseline document
              </h3>
              <p>
                {baselineRequirement
                  ? baselineRequirement.summary
                  : 'The BA agent will generate this after the clarification loop is complete.'}
              </p>
            </div>
            {baselineRequirement ? <pre>{baselineRequirement.output}</pre> : null}
          </aside>
        </div>
      </section>

      <section className="workspace-grid">
        <section className="workflow-panel" aria-label="Workflow">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Pipeline</p>
              <h2>Build, QA, PR, merge, deploy</h2>
            </div>
            <span className={`status-pill ${isWaiting ? 'warning' : isComplete ? 'success' : ''}`}>
              {isWaiting
                ? waitingForLlmApproval
                  ? 'LLM approval'
                  : waitingForRequirements
                  ? 'Requirements chat'
                  : waitingForAccess
                  ? 'Access blocker'
                  : 'Human action required'
                : isComplete
                  ? 'Production live'
                  : runStarted
                    ? 'In progress'
                    : 'Waiting for request'}
            </span>
          </div>

          <ol className="workflow-list">
            {WORKFLOW.map((step, index) => {
              const state = getStepState(index)
              const Icon = workflowIcons[step.id] ?? Circle
              const StatusIcon =
                state === 'complete'
                  ? CheckCircle2
                  : state === 'waiting'
                    ? AlertTriangle
                    : state === 'active'
                      ? Activity
                      : Circle

              return (
                <li className={`workflow-step ${state}`} key={step.id}>
                  <div className="workflow-node">
                    <StatusIcon size={18} />
                  </div>
                  <div className="workflow-content">
                    <div className="step-title-row">
                      <span className="lane">{step.lane}</span>
                      <span className="environment">{step.environment}</span>
                    </div>
                    <h3>
                      <Icon size={18} />
                      {step.label}
                    </h3>
                    <p>{step.detail}</p>
                    <div className="agent-tags">
                      {step.agents.map((agent) => (
                        <span key={agent}>{agent.replace(' agent', '')}</span>
                      ))}
                    </div>
                  </div>
                </li>
              )
            })}
          </ol>
        </section>

        <aside className="side-stack" aria-label="Agents and approvals">
          <section className="agents-panel">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Agents</p>
                <h2>Work allocation</h2>
              </div>
            </div>
            <div className="agent-list">
              {AGENTS.map((agent) => {
                const Icon = agentIcons[agent.name]
                const state = getAgentState(agent.name)
                const memory = getAgentMemory(agent.name)
                return (
                  <article className={`agent-row ${state.toLowerCase().replaceAll(' ', '-')}`} key={agent.name}>
                    <div className="agent-icon">
                      <Icon size={18} />
                    </div>
                    <div>
                      <div className="row-title">
                        <h3>{agent.shortName}</h3>
                        <span>{state}</span>
                      </div>
                      <p>{getAgentFocus(agent)}</p>
                      <div className="agent-learning">
                        <span>{memory?.handoffCount ?? 0} handoffs</span>
                        <span>{memory?.reviewCount ?? 0} reviews</span>
                      </div>
                      <p className="agent-lesson">
                        {memory?.learnedPatterns[0] ?? agent.reviewLens}
                      </p>
                    </div>
                  </article>
                )
              })}
            </div>
          </section>

          <section className="approval-panel">
            <div className="section-heading compact">
              <div>
                <p className="eyebrow">Human gates</p>
                <h2>Approval queue</h2>
              </div>
            </div>

            <div className="approval-list">
              {activeAccessBlocker ? (
                <article className="approval-row access-blocker-row">
                  <div>
                    <h3>
                      <LockKeyhole size={18} />
                      {activeAccessBlocker.environment} cloud access
                    </h3>
                    <p>{activeAccessBlocker.requestedResolution}</p>
                    <div className="access-blocker-details">
                      <span>Cloud: {activeAccessBlocker.cloudProvider}</span>
                      <span>Action: {activeAccessBlocker.action}</span>
                      <span>Resource: {activeAccessBlocker.resource}</span>
                    </div>
                    <ul>
                      {activeAccessBlocker.instructions.map((instruction) => (
                        <li key={instruction}>{instruction}</li>
                      ))}
                    </ul>
                  </div>
                  <div className="access-blocker-actions">
                    <button
                      type="button"
                      onClick={verifyAccessBlocker}
                      disabled={!waitingForAccess || isSubmitting}
                    >
                      <UserCheck size={16} />
                      Verify setup
                    </button>
                    <button
                      type="button"
                      onClick={keepAccessBlockerOpen}
                      disabled={!waitingForAccess || isSubmitting}
                    >
                      <AlertTriangle size={16} />
                      Still blocked
                    </button>
                  </div>
                </article>
              ) : null}

              <article className="approval-row">
                <div>
                  <h3>
                    <GitMerge size={18} />
                    Manual PR merge
                  </h3>
                  <p>{mergeApproved ? 'Merged into dev.' : 'Required before deployments begin.'}</p>
                </div>
                <button
                  type="button"
                  onClick={() => approveGate('merge')}
                  disabled={!waitingForMerge || isSubmitting}
                >
                  <UserCheck size={16} />
                  Mark merged
                </button>
              </article>

              <article className="approval-row">
                <div>
                  <h3>
                    <LockKeyhole size={18} />
                    Production approval
                  </h3>
                  <p>{prodApproved ? 'Approved for production.' : 'Required before prod deployment.'}</p>
                </div>
                <button
                  type="button"
                  onClick={() => approveGate('prod')}
                  disabled={!waitingForProd || isSubmitting}
                >
                  <ShieldCheck size={16} />
                  Approve prod
                </button>
              </article>
            </div>
          </section>
        </aside>
      </section>

      <section className="operations-grid">
        <section className="repo-panel">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Repository</p>
              <h2>PR readiness</h2>
            </div>
          </div>

          <div className="repo-details">
            <div className="repo-name-line">
              <GitBranch size={18} />
              <span>{repositoryName}</span>
            </div>
            <div className="branch-line">
              <GitBranch size={18} />
              <span>dev</span>
              <ArrowRight size={16} />
              <span>{branchName}</span>
              <ArrowRight size={16} />
              <span>dev</span>
            </div>
            <div className="branch-promotion">
              {environmentBranches.map((branch) => (
                <span key={branch.branchName}>
                  {branch.branchName}
                </span>
              ))}
            </div>
            <div className="check-grid">
              {readinessChecks.map(([label, stepId, Icon]) => (
                <div className="check-row" key={stepId}>
                  <Icon size={17} />
                  <span>{label}</span>
                  <strong>{checkStatus(stepId)}</strong>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="environment-panel">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Environments</p>
              <h2>Dev, stage, prod</h2>
            </div>
          </div>
          <div className="environment-list">
            {ENVIRONMENTS.map((environment) => {
              const status = environmentStatus(environment.stepId, environment.name)
              return (
                <article className={`environment-row ${status.toLowerCase().replaceAll(' ', '-')}`} key={environment.name}>
                  <div className="env-head">
                    <div>
                      <h3>{environment.name}</h3>
                      <p>{environment.purpose}</p>
                      <span className="env-branch">
                        Branch: {
                          environmentBranches.find(
                            (branch) => branch.environment === environment.name,
                          )?.branchName ?? environment.name.toLowerCase()
                        }
                      </span>
                    </div>
                    <strong>{status}</strong>
                  </div>
                  <div className="env-checks">
                    {environment.checks.map((check) => (
                      <span key={check}>
                        <CheckCircle2 size={14} />
                        {check}
                      </span>
                    ))}
                  </div>
                </article>
              )
            })}
          </div>
        </section>

        <section className="activity-panel">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Activity</p>
              <h2>Agent log</h2>
            </div>
          </div>
          <div className="activity-list">
            {logEntries.map((entry) => (
              <article className={`log-row ${entry.tone}`} key={entry.id}>
                <span>{entry.at}</span>
                <div>
                  <strong>{entry.actor}</strong>
                  <p>{entry.message}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="context-engine-panel">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Context engine</p>
              <h2>
                <FileCheck2 size={20} />
                Decision trace
              </h2>
            </div>
            <span className="status-pill">
              v{contextSummary?.version ?? 0}
            </span>
          </div>

          <div className="context-engine-layout">
            <article className="context-summary-card">
              <div className="review-meta">
                <span>Source of truth</span>
                <strong>{contextSummary?.sourceOfTruth ?? 'feature request'}</strong>
              </div>
              <h3>{contextSummary?.summary ?? 'Context pack will appear after a run starts.'}</h3>
              <div className="context-chip-list">
                {(contextSummary?.requirementDigest ?? ['No requirement digest yet.'])
                  .slice(0, 4)
                  .map((item) => (
                    <span key={item}>{item}</span>
                  ))}
              </div>
            </article>

            <div className="context-lists">
              <article>
                <h3>Risks and blockers</h3>
                {(contextSummary?.risks ?? ['No risks recorded yet.'])
                  .slice(0, 3)
                  .map((item) => (
                    <p key={item}>{item}</p>
                  ))}
                {(contextSummary?.blockers ?? [])
                  .filter((item) => !item.toLowerCase().includes('no blockers'))
                  .slice(0, 2)
                  .map((item) => (
                    <p key={item}>{item}</p>
                  ))}
              </article>

              <article>
                <h3>Active packs</h3>
                {(activeContextPacks.length > 0 ? activeContextPacks : contextPacks.slice(0, 2)).map((pack) => (
                  <p key={pack.agentName}>
                    <strong>{pack.agentName.replace(' agent', '')}:</strong> {pack.focus}
                  </p>
                ))}
                {contextPacks.length === 0 ? <p>No agent context packs yet.</p> : null}
              </article>
            </div>

            <div className="decision-trace-list">
              {latestDecisionTrace.length === 0 ? (
                <article className="trace-empty">
                  Decision trace entries appear as requirements, handoffs, reviews, blockers, and approvals are recorded.
                </article>
              ) : (
                latestDecisionTrace.map((entry) => (
                  <article className={`trace-row ${entry.type}`} key={entry.id}>
                    <div className="review-meta">
                      <span>{entry.type.replace('-', ' ')}</span>
                      <strong>{entry.modelTier}</strong>
                    </div>
                    <h3>{entry.title}</h3>
                    <p>{entry.summary}</p>
                    <p>{entry.rationale}</p>
                  </article>
                ))
              )}
            </div>
          </div>
        </section>

        <section className="team-panel">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Team intelligence</p>
              <h2>
                <ClipboardCheck size={20} />
                Reviews and memory
              </h2>
            </div>
            <span className="status-pill">
              {peerReviews.length} checks
            </span>
          </div>
          <div className="team-layout">
            <div className="review-list">
              {latestPeerReviews.length === 0 ? (
                <article className="team-empty">
                  Cross-agent reviews appear after the baseline or a handoff is produced.
                </article>
              ) : (
                latestPeerReviews.map((review) => (
                  <article className={`review-row ${review.status}`} key={review.id}>
                    <div className="review-meta">
                      <span>{review.stepLabel}</span>
                      <strong>{review.status.replace('-', ' ')}</strong>
                    </div>
                    <h3>
                      {review.reviewerAgent.replace(' agent', '')} checked {review.targetAgent.replace(' agent', '')}
                    </h3>
                    <p>{review.finding}</p>
                    <p>{review.recommendation}</p>
                  </article>
                ))
              )}
            </div>
            <div className="memory-list">
              {agentMemory.map((memory) => (
                <article className="memory-row" key={memory.agentName}>
                  <div className="review-meta">
                    <span>{memory.agentName.replace(' agent', '')}</span>
                    <strong>{memory.handoffCount + memory.reviewCount} learns</strong>
                  </div>
                  <h3>{memory.specialization}</h3>
                  <p>{memory.learnedPatterns[0]}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="artifact-panel">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">Agent artifacts</p>
              <h2>Persona output</h2>
            </div>
            <span className="status-pill">
              {llmProvider.model}
            </span>
          </div>
          <div className="artifact-list">
            {artifacts.length === 0 ? (
              <article className="artifact-empty">
                Start a run to generate persona handoffs for each step.
              </article>
            ) : (
              artifacts.slice(-6).reverse().map((artifact) => (
                <article className="artifact-row" key={artifact.id}>
                  <div className="artifact-meta">
                    <span>{artifact.stepLabel}</span>
                    <strong>{artifact.agentName.replace(' agent', '')}</strong>
                  </div>
                  <h3>{artifact.title}</h3>
                  <p>{artifact.summary}</p>
                  <pre>{artifact.output}</pre>
                </article>
              ))
            )}
          </div>
        </section>
      </section>
    </main>
  )
}

export default App
