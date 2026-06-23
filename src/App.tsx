import { useCallback, useEffect, useMemo, useState } from 'react'
import type { LucideIcon } from 'lucide-react'
import {
  Activity,
  AlertTriangle,
  ArrowRight,
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
  WORKFLOW,
  slugify,
  type AgentArtifact,
  type AgentName,
  type GateType,
  type LlmProviderStatus,
  type LogEntry,
  type RequirementsState,
  type StepState,
  type WorkflowStep,
} from './orchestratorModel'
import './App.css'

type ApiStatus = 'checking' | 'online' | 'offline'
type RunStatus =
  | 'requirements'
  | 'running'
  | 'paused'
  | 'waiting-for-human'
  | 'complete'

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
  requirements: RequirementsState
  logEntries: LogEntry[]
  currentStep?: WorkflowStep
  isComplete: boolean
  waitingForRequirements: boolean
  waitingForMerge: boolean
  waitingForProd: boolean
  isWaiting: boolean
  progress: number
  status: RunStatus
  artifacts: AgentArtifact[]
  llmProvider: LlmProviderStatus
}

type RunResponse = {
  run: OrchestratorRun | null
}

type HealthResponse = {
  llmProvider: LlmProviderStatus
}

type ApiErrorResponse = {
  error?: string
}

const API_BASE_URL =
  import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:3001'

const defaultRequest =
  'Build a customer onboarding checklist with role-based approval and audit history.'

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
  'Software agent': Code2,
  'Tester agent': Bug,
  'DevOps agent': Terminal,
}

const readinessChecks: Array<[string, string, LucideIcon]> = [
  ['Build', 'build-code', Wrench],
  ['QA', 'qa-code', Bug],
  ['Check in', 'check-in', FileCheck2],
  ['Pull request', 'pull-request', GitPullRequest],
]

const requestApi = async <T,>(path: string, options: RequestInit = {}) => {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
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
  const [featureRequest, setFeatureRequest] = useState(defaultRequest)
  const [run, setRun] = useState<OrchestratorRun | null>(null)
  const [apiStatus, setApiStatus] = useState<ApiStatus>('checking')
  const [apiError, setApiError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [requirementAnswer, setRequirementAnswer] = useState('')
  const [llmProvider, setLlmProvider] = useState<LlmProviderStatus>({
    mode: 'mock',
    model: 'mock-local-persona',
    configured: false,
  })

  const runStarted = Boolean(run)
  const currentStepIndex = run?.currentStepIndex ?? 0
  const currentStep = WORKFLOW[currentStepIndex]
  const isComplete = Boolean(run?.isComplete)
  const waitingForRequirements = Boolean(run?.waitingForRequirements)
  const waitingForMerge = Boolean(run?.waitingForMerge)
  const waitingForProd = Boolean(run?.waitingForProd)
  const isWaiting = Boolean(run?.isWaiting)
  const isRunning = Boolean(run?.isRunning)
  const mergeApproved = Boolean(run?.mergeApproved)
  const prodApproved = Boolean(run?.prodApproved)
  const progress = run?.progress ?? 0
  const logEntries = run?.logEntries ?? defaultLogEntries
  const artifacts = run?.artifacts ?? []
  const requirementMessages = run?.requirements.messages ?? []
  const baselineRequirement = run?.requirements.baselineArtifactId
    ? artifacts.find((artifact) => artifact.id === run.requirements.baselineArtifactId)
    : undefined
  const canSendRequirementMessage =
    runStarted && apiStatus === 'online' && !isSubmitting

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
      setRun(response.run)
      if (response.run) setFeatureRequest(response.run.featureRequest)
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
    if (response.run) setFeatureRequest(response.run.featureRequest)
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
    if (index === 0 && waitingForRequirements) return 'waiting'
    if (WORKFLOW[index].gate && isWaiting) return 'waiting'
    return 'active'
  }

  const startRun = () => {
    const trimmedRequest = featureRequest.trim()
    if (!trimmedRequest) return

    void mutateRun(() =>
      requestApi<RunResponse>('/api/runs', {
        method: 'POST',
        body: JSON.stringify({ featureRequest: trimmedRequest }),
      }),
    )
  }

  const sendRequirementAnswer = () => {
    if (!run || !requirementAnswer.trim()) return

    const message = requirementAnswer.trim()
    setRequirementAnswer('')
    void mutateRun(() =>
      requestApi<RunResponse>(`/api/runs/${run.id}/requirements/messages`, {
        method: 'POST',
        body: JSON.stringify({ message }),
      }),
    )
  }

  const resetRun = () => {
    if (!run) {
      setFeatureRequest(defaultRequest)
      setApiError(null)
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
      return isWaiting ? 'Blocked on a human gate.' : currentStep.detail
    }
    return getAgentState(agent.name) === 'Complete'
      ? 'Assigned workflow is complete.'
      : agent.mission
  }

  const environmentStatus = (stepId: string, envName: string) => {
    const deployIndex = WORKFLOW.findIndex((step) => step.id === stepId)

    if (!runStarted) return 'Ready'
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

  return (
    <main className="orchestrator-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Local agent orchestrator</p>
          <h1>Feature delivery control plane</h1>
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
              !featureRequest.trim() ||
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

      <section className="request-panel" aria-label="Feature request">
        <div className="request-copy">
          <label htmlFor="feature-request">Feature or tool request</label>
          <textarea
            id="feature-request"
            value={featureRequest}
            onChange={(event) => setFeatureRequest(event.target.value)}
            rows={3}
            spellCheck="true"
            disabled={runStarted && !isComplete}
          />
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
                : waitingForRequirements
                  ? 'Requirements'
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
            <span>Branch</span>
            <strong>{branchName}</strong>
          </div>
        </div>
      </section>

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
                ? waitingForRequirements
                  ? 'Requirements chat'
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
              <article className="approval-row">
                <div>
                  <h3>
                    <GitMerge size={18} />
                    Manual PR merge
                  </h3>
                  <p>{mergeApproved ? 'Merged into main.' : 'Required before deployments begin.'}</p>
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
            <div className="branch-line">
              <GitBranch size={18} />
              <span>{branchName}</span>
              <ArrowRight size={16} />
              <span>main</span>
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

        <section className="artifact-panel">
          <div className="section-heading compact">
            <div>
              <p className="eyebrow">LLM artifacts</p>
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
