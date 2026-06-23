export type AgentName =
  | 'Business analyst agent'
  | 'Software agent'
  | 'Tester agent'
  | 'DevOps agent'

export type GateType = 'merge' | 'prod'
export type StepState = 'pending' | 'active' | 'complete' | 'waiting'
export type Tone = 'info' | 'success' | 'warning'
export type EnvironmentName = 'Backlog' | 'Repository' | 'Dev' | 'Stage' | 'Prod'

export type WorkflowStep = {
  id: string
  label: string
  lane: string
  detail: string
  environment: EnvironmentName
  agents: AgentName[]
  gate?: GateType
}

export type Agent = {
  name: AgentName
  shortName: string
  mission: string
}

export type EnvironmentTarget = {
  name: 'Dev' | 'Stage' | 'Prod'
  purpose: string
  stepId: string
  checks: string[]
}

export type LogEntry = {
  id: string
  at: string
  actor: string
  message: string
  tone: Tone
}

export type AgentArtifact = {
  id: string
  stepId: string
  stepLabel: string
  agentName: AgentName
  title: string
  summary: string
  output: string
  provider: 'openai' | 'mock'
  model: string
  createdAt: string
}

export type LlmProviderStatus = {
  mode: 'openai' | 'mock'
  model: string
  configured: boolean
}

export type PendingLlmCall = {
  id: string
  kind: 'ba-requirements' | 'agent-step'
  title: string
  description: string
  model: string
  estimatedInputTokens: number
  maxOutputTokens: number
  estimatedInputCostUsd: number
  estimatedOutputCostUsd: number
  estimatedTotalCostUsd: number
  createdAt: string
}

export type RequirementChatMessage = {
  id: string
  role: 'user' | 'ba'
  content: string
  createdAt: string
}

export type RequirementsStatus = 'clarifying' | 'complete'

export type RequirementsState = {
  status: RequirementsStatus
  messages: RequirementChatMessage[]
  baselineArtifactId?: string
}

export const WORKFLOW: WorkflowStep[] = [
  {
    id: 'intake',
    label: 'Feature intake',
    lane: 'Plan',
    detail: 'Capture scope, acceptance criteria, risks, and release target.',
    environment: 'Backlog',
    agents: ['Business analyst agent'],
  },
  {
    id: 'solution-plan',
    label: 'Solution plan',
    lane: 'Plan',
    detail: 'Split the work into branch tasks, test notes, and deployment needs.',
    environment: 'Repository',
    agents: ['Business analyst agent', 'Software agent'],
  },
  {
    id: 'build-code',
    label: 'Build code',
    lane: 'Build',
    detail: 'Implement the feature on an isolated branch with local checks.',
    environment: 'Dev',
    agents: ['Software agent'],
  },
  {
    id: 'qa-code',
    label: 'QA code',
    lane: 'Verify',
    detail: 'Run functional, regression, and acceptance coverage.',
    environment: 'Dev',
    agents: ['Tester agent'],
  },
  {
    id: 'check-in',
    label: 'Check in code',
    lane: 'Repository',
    detail: 'Commit reviewed changes and attach traceable work notes.',
    environment: 'Repository',
    agents: ['Software agent'],
  },
  {
    id: 'pull-request',
    label: 'Conduct pull request',
    lane: 'Repository',
    detail: 'Open PR, publish build evidence, and request human review.',
    environment: 'Repository',
    agents: ['DevOps agent', 'Software agent'],
  },
  {
    id: 'human-merge',
    label: 'Human merge',
    lane: 'Approval',
    detail: 'Human manually merges the pull request before deployment begins.',
    environment: 'Repository',
    agents: ['DevOps agent'],
    gate: 'merge',
  },
  {
    id: 'deploy-dev',
    label: 'Deploy dev',
    lane: 'Deploy',
    detail: 'Deploy merged code to the local dev environment.',
    environment: 'Dev',
    agents: ['DevOps agent'],
  },
  {
    id: 'deploy-stage',
    label: 'Deploy stage',
    lane: 'Deploy',
    detail: 'Promote the same build artifact into stage for release validation.',
    environment: 'Stage',
    agents: ['DevOps agent', 'Tester agent'],
  },
  {
    id: 'prod-approval',
    label: 'Human prod approval',
    lane: 'Approval',
    detail: 'Human signs off before anything can deploy to production.',
    environment: 'Prod',
    agents: ['DevOps agent'],
    gate: 'prod',
  },
  {
    id: 'deploy-prod',
    label: 'Deploy prod',
    lane: 'Deploy',
    detail: 'Deploy to production, run smoke checks, and keep monitoring open.',
    environment: 'Prod',
    agents: ['DevOps agent', 'Tester agent'],
  },
]

export const AGENTS: Agent[] = [
  {
    name: 'Business analyst agent',
    shortName: 'Business analyst',
    mission: 'Requirements, acceptance criteria, and release notes.',
  },
  {
    name: 'Software agent',
    shortName: 'Software',
    mission: 'Code implementation, branch work, and commits.',
  },
  {
    name: 'Tester agent',
    shortName: 'Tester',
    mission: 'QA coverage, regression checks, and evidence.',
  },
  {
    name: 'DevOps agent',
    shortName: 'DevOps',
    mission: 'PR operations, environments, and deployments.',
  },
]

export const ENVIRONMENTS: EnvironmentTarget[] = [
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

export const slugify = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 42)
