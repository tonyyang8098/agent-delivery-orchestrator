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
  GitBranch,
  GitMerge,
  GitPullRequest,
  LockKeyhole,
  Pause,
  Play,
  RefreshCcw,
  Rocket,
  Server,
  ShieldCheck,
  Terminal,
  UserCheck,
  UsersRound,
  Wrench,
} from 'lucide-react'
import './App.css'

type AgentName =
  | 'Business analyst agent'
  | 'Software agent'
  | 'Tester agent'
  | 'DevOps agent'

type GateType = 'merge' | 'prod'
type StepState = 'pending' | 'active' | 'complete' | 'waiting'
type Tone = 'info' | 'success' | 'warning'

type WorkflowStep = {
  id: string
  label: string
  lane: string
  detail: string
  environment: 'Backlog' | 'Repository' | 'Dev' | 'Stage' | 'Prod'
  agents: AgentName[]
  icon: LucideIcon
  gate?: GateType
}

type Agent = {
  name: AgentName
  shortName: string
  mission: string
  icon: LucideIcon
}

type LogEntry = {
  id: string
  at: string
  actor: string
  message: string
  tone: Tone
}

const WORKFLOW: WorkflowStep[] = [
  {
    id: 'intake',
    label: 'Feature intake',
    lane: 'Plan',
    detail: 'Capture scope, acceptance criteria, risks, and release target.',
    environment: 'Backlog',
    agents: ['Business analyst agent'],
    icon: ClipboardCheck,
  },
  {
    id: 'solution-plan',
    label: 'Solution plan',
    lane: 'Plan',
    detail: 'Split the work into branch tasks, test notes, and deployment needs.',
    environment: 'Repository',
    agents: ['Business analyst agent', 'Software agent'],
    icon: Boxes,
  },
  {
    id: 'build-code',
    label: 'Build code',
    lane: 'Build',
    detail: 'Implement the feature on an isolated branch with local checks.',
    environment: 'Dev',
    agents: ['Software agent'],
    icon: Code2,
  },
  {
    id: 'qa-code',
    label: 'QA code',
    lane: 'Verify',
    detail: 'Run functional, regression, and acceptance coverage.',
    environment: 'Dev',
    agents: ['Tester agent'],
    icon: Bug,
  },
  {
    id: 'check-in',
    label: 'Check in code',
    lane: 'Repository',
    detail: 'Commit reviewed changes and attach traceable work notes.',
    environment: 'Repository',
    agents: ['Software agent'],
    icon: GitBranch,
  },
  {
    id: 'pull-request',
    label: 'Conduct pull request',
    lane: 'Repository',
    detail: 'Open PR, publish build evidence, and request human review.',
    environment: 'Repository',
    agents: ['DevOps agent', 'Software agent'],
    icon: GitPullRequest,
  },
  {
    id: 'human-merge',
    label: 'Human merge',
    lane: 'Approval',
    detail: 'Human manually merges the pull request before deployment begins.',
    environment: 'Repository',
    agents: ['DevOps agent'],
    icon: GitMerge,
    gate: 'merge',
  },
  {
    id: 'deploy-dev',
    label: 'Deploy dev',
    lane: 'Deploy',
    detail: 'Deploy merged code to the local dev environment.',
    environment: 'Dev',
    agents: ['DevOps agent'],
    icon: Server,
  },
  {
    id: 'deploy-stage',
    label: 'Deploy stage',
    lane: 'Deploy',
    detail: 'Promote the same build artifact into stage for release validation.',
    environment: 'Stage',
    agents: ['DevOps agent', 'Tester agent'],
    icon: Rocket,
  },
  {
    id: 'prod-approval',
    label: 'Human prod approval',
    lane: 'Approval',
    detail: 'Human signs off before anything can deploy to production.',
    environment: 'Prod',
    agents: ['DevOps agent'],
    icon: LockKeyhole,
    gate: 'prod',
  },
  {
    id: 'deploy-prod',
    label: 'Deploy prod',
    lane: 'Deploy',
    detail: 'Deploy to production, run smoke checks, and keep monitoring open.',
    environment: 'Prod',
    agents: ['DevOps agent', 'Tester agent'],
    icon: ShieldCheck,
  },
]

const AGENTS: Agent[] = [
  {
    name: 'Business analyst agent',
    shortName: 'Business analyst',
    mission: 'Requirements, acceptance criteria, and release notes.',
    icon: UsersRound,
  },
  {
    name: 'Software agent',
    shortName: 'Software',
    mission: 'Code implementation, branch work, and commits.',
    icon: Code2,
  },
  {
    name: 'Tester agent',
    shortName: 'Tester',
    mission: 'QA coverage, regression checks, and evidence.',
    icon: Bug,
  },
  {
    name: 'DevOps agent',
    shortName: 'DevOps',
    mission: 'PR operations, environments, and deployments.',
    icon: Terminal,
  },
]

const ENVIRONMENTS = [
  {
    name: 'Dev',
    purpose: 'Agent validation',
    stepId: 'deploy-dev',
    checks: ['Build artifact', 'Smoke tests'],
  },
  {
    name: 'Stage',
    purpose: 'Release validation',
    stepId: 'deploy-stage',
    checks: ['Regression set', 'Approval evidence'],
  },
  {
    name: 'Prod',
    purpose: 'Human-approved release',
    stepId: 'deploy-prod',
    checks: ['Approval gate', 'Post-deploy monitor'],
  },
]

const defaultRequest =
  'Build a customer onboarding checklist with role-based approval and audit history.'

const makeLogEntry = (actor: string, message: string, tone: Tone = 'info') => ({
  id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
  at: new Date().toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }),
  actor,
  message,
  tone,
})

const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)

function App() {
  const [featureRequest, setFeatureRequest] = useState(defaultRequest)
  const [runStarted, setRunStarted] = useState(false)
  const [isRunning, setIsRunning] = useState(false)
  const [currentStepIndex, setCurrentStepIndex] = useState(0)
  const [mergeApproved, setMergeApproved] = useState(false)
  const [prodApproved, setProdApproved] = useState(false)
  const [logEntries, setLogEntries] = useState<LogEntry[]>([
    makeLogEntry('Orchestrator', 'Local control plane is ready.'),
  ])

  const currentStep = WORKFLOW[currentStepIndex]
  const isComplete = runStarted && currentStepIndex >= WORKFLOW.length
  const waitingForMerge =
    runStarted && currentStep?.gate === 'merge' && !mergeApproved
  const waitingForProd =
    runStarted && currentStep?.gate === 'prod' && !prodApproved
  const isWaiting = waitingForMerge || waitingForProd
  const completedCount = runStarted
    ? Math.min(currentStepIndex, WORKFLOW.length)
    : 0
  const progress = Math.round((completedCount / WORKFLOW.length) * 100)

  const branchName = useMemo(() => {
    const slug = slugify(featureRequest) || 'new-local-work-item'
    return `feature/${slug}`
  }, [featureRequest])

  const appendLog = useCallback((actor: string, message: string, tone: Tone = 'info') => {
    setLogEntries((entries) => [...entries, makeLogEntry(actor, message, tone)].slice(-12))
  }, [])

  const getStepState = (index: number): StepState => {
    if (!runStarted) return 'pending'
    if (index < currentStepIndex) return 'complete'
    if (index > currentStepIndex || isComplete) return 'pending'
    if (WORKFLOW[index].gate && isWaiting) return 'waiting'
    return 'active'
  }

  const startRun = () => {
    const trimmedRequest = featureRequest.trim()
    if (!trimmedRequest) return

    setRunStarted(true)
    setIsRunning(true)
    setCurrentStepIndex(0)
    setMergeApproved(false)
    setProdApproved(false)
    setLogEntries([
      makeLogEntry('User request', trimmedRequest),
      makeLogEntry(
        'Orchestrator',
        'Run started. Business analyst agent is taking intake.',
        'success',
      ),
    ])
  }

  const resetRun = () => {
    setRunStarted(false)
    setIsRunning(false)
    setCurrentStepIndex(0)
    setMergeApproved(false)
    setProdApproved(false)
    setLogEntries([makeLogEntry('Orchestrator', 'Workspace reset for the next feature.')])
  }

  const completeActiveStep = useCallback(() => {
    const step = WORKFLOW[currentStepIndex]
    if (!step) return

    appendLog(
      step.agents.join(' + '),
      `${step.label} complete. ${step.environment} handoff updated.`,
      'success',
    )

    const nextIndex = currentStepIndex + 1
    const nextStep = WORKFLOW[nextIndex]
    setCurrentStepIndex(nextIndex)

    if (!nextStep) {
      setIsRunning(false)
      appendLog('Orchestrator', 'Release completed through production.', 'success')
      return
    }

    if (nextStep.gate === 'merge' && !mergeApproved) {
      setIsRunning(false)
      appendLog('Human gate', 'Pull request is ready for manual merge.', 'warning')
      return
    }

    if (nextStep.gate === 'prod' && !prodApproved) {
      setIsRunning(false)
      appendLog('Human gate', 'Production deployment is waiting for approval.', 'warning')
    }
  }, [appendLog, currentStepIndex, mergeApproved, prodApproved])

  useEffect(() => {
    if (!runStarted || !isRunning || isWaiting || isComplete) return

    const timer = window.setTimeout(() => {
      completeActiveStep()
    }, 1300)

    return () => window.clearTimeout(timer)
  }, [completeActiveStep, isComplete, isRunning, isWaiting, runStarted])

  const approveGate = (gate: GateType) => {
    if (!currentStep || currentStep.gate !== gate) return

    if (gate === 'merge') {
      setMergeApproved(true)
      setCurrentStepIndex((index) => index + 1)
      setIsRunning(true)
      appendLog('Human reviewer', 'Pull request manually merged into main.', 'success')
      return
    }

    setProdApproved(true)
    setCurrentStepIndex((index) => index + 1)
    setIsRunning(true)
    appendLog('Human approver', 'Production release approved.', 'success')
  }

  const toggleRunning = () => {
    if (!runStarted) {
      startRun()
      return
    }
    if (isComplete || isWaiting) return
    setIsRunning((running) => !running)
  }

  const getAgentState = (agentName: AgentName) => {
    const indexes = WORKFLOW.flatMap((step, index) =>
      step.agents.includes(agentName) ? [index] : [],
    )
    const firstIndex = indexes[0] ?? Number.POSITIVE_INFINITY
    const lastIndex = indexes[indexes.length - 1] ?? -1
    const isAssignedNow = Boolean(currentStep?.agents.includes(agentName))

    if (!runStarted) return 'Idle'
    if (isAssignedNow && isWaiting) return 'Waiting'
    if (isAssignedNow) return 'Working'
    if (currentStepIndex > lastIndex) return 'Complete'
    if (currentStepIndex > firstIndex) return 'Standing by'
    return 'Queued'
  }

  const getAgentFocus = (agent: Agent) => {
    if (currentStep?.agents.includes(agent.name)) {
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
          <button
            type="button"
            className="primary-action"
            onClick={runStarted ? toggleRunning : startRun}
            disabled={!featureRequest.trim() || isComplete || isWaiting}
            title={runStarted && isRunning ? 'Pause run' : 'Start or resume run'}
          >
            {runStarted && isRunning ? <Pause size={18} /> : <Play size={18} />}
            <span>{runStarted && isRunning ? 'Pause' : runStarted ? 'Resume' : 'Start'}</span>
          </button>
          <button
            type="button"
            className="icon-action"
            onClick={resetRun}
            title="Reset run"
            aria-label="Reset run"
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
          />
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

      <section className="workspace-grid">
        <section className="workflow-panel" aria-label="Workflow">
          <div className="section-heading">
            <div>
              <p className="eyebrow">Pipeline</p>
              <h2>Build, QA, PR, merge, deploy</h2>
            </div>
            <span className={`status-pill ${isWaiting ? 'warning' : isComplete ? 'success' : ''}`}>
              {isWaiting ? 'Human action required' : isComplete ? 'Production live' : 'In progress'}
            </span>
          </div>

          <ol className="workflow-list">
            {WORKFLOW.map((step, index) => {
              const state = getStepState(index)
              const Icon = step.icon
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
                const Icon = agent.icon
                const state = getAgentState(agent.name)
                return (
                  <article className={`agent-row ${state.toLowerCase().replace(' ', '-')}`} key={agent.name}>
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
                  disabled={!waitingForMerge}
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
                  disabled={!waitingForProd}
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
              {[
                ['Build', 'build-code', Wrench],
                ['QA', 'qa-code', Bug],
                ['Check in', 'check-in', FileCheck2],
                ['Pull request', 'pull-request', GitPullRequest],
              ].map(([label, stepId, Icon]) => (
                <div className="check-row" key={stepId as string}>
                  <Icon size={17} />
                  <span>{label as string}</span>
                  <strong>{checkStatus(stepId as string)}</strong>
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
      </section>
    </main>
  )
}

export default App
