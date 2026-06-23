# Project Context

Last updated: 2026-06-23

This file is the durable context record for the Agent Delivery Orchestrator repo. Keep it free of secrets, customer data, uploaded binaries, and local runtime memory.

## Product Goal

Build a locally hosted visual UI for orchestrating an AI-assisted software delivery team. A user names a project, describes a feature or tool, optionally uploads requirement/sample-data files, and the agent team drives the work from requirements through architecture, implementation planning, QA, repository operations, human gates, and deployment.

The tool is purpose-bound to software delivery work. It should not behave like a general chatbot for unrelated questions.

## Current Architecture

- Frontend: React, TypeScript, Vite.
- Backend: Node, Express, TypeScript via `tsx`.
- State: in-memory active run state in the backend.
- Local runtime memory: `local-state/agent-memory.json`, ignored by Git.
- LLM provider: per-agent routing across local OpenAI-compatible endpoints, OpenAI, or mock output.
- Local model plan: Software uses `Qwen3-Coder-Next`; Business analyst, Architect, Tester, and DevOps use `Qwen3.6-27B` when local hardware can run it; `Phi-4-mini-instruct` is the cheap/light local fallback.
- Paid fallback model: `gpt-5.4-mini`, enabled only when an agent is explicitly routed to OpenAI and `OPENAI_API_KEY` is present.
- Cost control: every paid OpenAI call pauses for explicit user approval unless `LLM_REQUIRE_APPROVAL=false`. Local Ollama/vLLM calls are treated as local `$0` compute.

## Interface Direction

- Product brand: AgentFlow Studio.
- Primary screen: a local delivery control plane, not a marketing landing page.
- Visual identity: restrained operational UI with a branded lockup, blue/teal/slate system palette, and compact status chips.
- Processing visualization: an animated agent-flow panel shows the current delivery stage, active agents, progress metrics, and moving context signal while agents are running.
- Navigation model: a workspace navigation strip links directly to request intake, preview/testing, requirements, workflow, release, and intelligence sections so the operator does not need to hunt through panels.

## Agent Team

The UI and backend model five personas:

- Business analyst agent: requirement discovery, scope control, user stories, acceptance criteria, stakeholder language.
- Architect agent: architecture design, system decomposition, data flow, integration boundaries, non-functional constraints.
- Software agent: implementation design, code structure, branch-ready tasks, engineering tradeoffs.
- Tester agent: acceptance coverage, regression risk, test data, release evidence.
- DevOps agent: repository operations, pull requests, environments, deployment, rollback, release traceability.

Persona definitions live in code:

- Agent metadata: `src/orchestratorModel.ts`
- Persona prompts: `server/index.ts`

## Workflow

The delivery flow is:

1. Feature intake.
2. Parallel architecture design and user-story creation.
3. Developer handoff, blocked until design and stories are complete.
4. Build code.
5. QA code.
6. Check in code.
7. Conduct pull request.
8. Human manually merges.
9. Deploy dev.
10. Deploy stage.
11. Human approves production.
12. Deploy prod.

Human involvement is required before production deployment.

## Project And Repository Model

The intake form includes a project name. The backend normalizes that project name into a GitHub-ready repository slug for the run.

The DevOps branch plan is:

- `dev`: lowest environment and base for feature work.
- `stage`: promoted from `dev`.
- `prod`: promoted from `stage` after human production approval.

Feature branches are generated as `feature/<slug>` and are treated as starting from `dev`. Pull requests target `dev`; promotion flows `dev -> stage -> prod`.

Current implementation prepares and displays this repository/branch plan locally. It does not yet create real GitHub repositories or branches through a GitHub API integration.

## Requirements Intake

The Business Analyst agent asks one question at a time until requirements are ready.

In mock mode, the BA asks three fixed discovery questions, then creates a baseline requirements document.

In LLM mode, the BA decides dynamically whether requirements are complete. The BA is instructed to check these gaps before completing the baseline:

- users/personas
- business outcome
- scope boundaries
- workflows
- data
- rules
- integrations
- audit/security
- acceptance criteria
- edge cases
- deployment constraints

Once the baseline exists, the BA chat remains open so the user can expand scope, add features, modify requirements, or delete existing features. Accepted changes create a new baseline requirements document version.

## Uploaded Context Files

The intake form supports:

- Requirement documents: `.txt`, `.md`, `.docx`
- Sample datasets: `.csv`, `.xlsx`

Files are parsed in memory by the backend. Uploaded binaries are not written to disk. Extracted text, row/column summaries, and small previews become run context for BA clarification, baseline creation, architecture, stories, and downstream agent handoffs.

## Local Preview And Testing

The UI has a Preview & smoke checks section. It calls:

```text
POST /api/runs/:runId/local-preview
```

The backend generates deterministic preview files under:

```text
local-state/previews/<runId>/index.html
```

The files are served by the local API at:

```text
/local-previews/<runId>/index.html
```

This runtime preview directory is ignored by Git. Preview generation does not call a paid LLM, local model, cloud provider, GitHub, or deployment adapter.

Current behavior:

- Pong/table-tennis runs generate a playable browser Pong game with a canvas loop, mouse paddle control, scoring, and restart.
- Other runs generate a static local project brief showing the feature, repository, branch plan, baseline summary, environment promotion path, and recent agent handoffs.
- The local test harness attaches smoke-check results to `run.localPreview` and records a `local-test` decision trace entry.

## Guardrails

The backend rejects unrelated prompts before creating a run or accepting BA chat messages.

Allowed use is limited to software delivery work: feature or tool requests, requirements, scope changes, architecture, implementation, QA, repository work, deployment, and supporting context files.

Sample data alone cannot start a run. It must support a feature request or requirement document.

## Agent Collaboration And Learning

Agents review each other's work using their own review lens. Peer reviews are stored on the active run and can be `approved`, `watch`, or `changes-requested`.

The backend also writes lightweight local memory to `local-state/agent-memory.json`. Each agent keeps recent learned patterns, handoff counts, review counts, and update timestamps. This memory is injected into future prompts.

This is not model training or fine-tuning. The model itself does not permanently change. Improvement happens through local memory being added to future prompt context.

## Context Engine And Decision Trace

The app now keeps structured context instead of raw hidden chain-of-thought.

- Context summary: compact source-of-truth digest with requirements, uploaded files, assumptions, decisions, risks, blockers, approvals, and token-budget guidance.
- Agent context packs: per-agent compact packets containing focus, relevant decisions, risks, blockers, source refs, and agent memory.
- Decision trace: auditable entries for requirement intake, BA clarification, baseline completion, gate validation, handoffs, peer reviews, blockers, LLM spend choices, and human approvals.
- Prompt injection: BA and downstream agent prompts receive the compact context pack before full baseline/artifact details.
- Gate validation: baseline completion, developer handoff, pull request, production approval, and release completion record explicit validation entries.

The current implementation is deterministic and local, so it does not spend LLM budget. The intended future upgrade is to let a cheap/local model compress context, then let the stronger routed model validate summaries only at important gates.

## LLM And Cost Rules

User preference for this project:

- Use local open-weight models for cost-efficient daily orchestration.
- Use `Qwen3-Coder-Next` for the Software agent.
- Use `Qwen3.6-27B` for BA, Architect, Tester, and DevOps when local hardware can run it.
- Use `Phi-4-mini-instruct` as the cheap/light local fallback.
- Keep `gpt-5.4-mini` as the approved paid fallback for hard cases.
- Be cost efficient.
- Before any paid LLM call, show the estimated model, input tokens, max output tokens, and estimated cost.
- Do not approve or run paid LLM calls unless the user explicitly approves.

The browser never receives the OpenAI API key. The key belongs only in local `.env`, which is ignored by Git.

The backend model routing is configured through `.env`:

- `LLM_PROVIDER=mock|local|openai`
- `LOCAL_LLM_BASE_URL` for Ollama/vLLM OpenAI-compatible `/v1` endpoints
- `*_AGENT_PROVIDER=local|openai|mock`
- `*_AGENT_LOCAL_MODEL` and `*_AGENT_OPENAI_MODEL`

## Cloud Deployment Direction

Azure and AWS deployment adapters are not implemented yet. The current DevOps behavior is simulated local orchestration and handoff generation, but the workflow now has a first-class deployment access blocker.

The desired future model is:

- Dev/stage deployment through scoped automation roles or service principals.
- Prod deployment behind a human approval gate.
- Agent triggers only approved scripts, IaC, or CI/CD workflows.
- Before each deployment environment, DevOps instructs the human to provide scoped AWS/Azure access requirements.
- If access is missing, DevOps creates an access blocker with environment, cloud, attempted action, resource, missing permissions, evidence, and requested human resolution.
- The run stays parked while the blocker is open.
- Once the human completes setup, DevOps verifies the setup and resumes. In the current local prototype, verification records human confirmation; future AWS/Azure adapters should perform real IAM/RBAC checks.

Secrets and cloud credentials must not be committed. Future integrations should use local environment variables for development and secure secret stores or OIDC federation for CI/CD.

## Known Limitations

- Backend run state is in memory and resets when the API restarts.
- Real GitHub repo/branch/PR creation is not connected yet.
- Real AWS/Azure deployment is not connected yet.
- Deployment access verification is local/manual until cloud adapters are added.
- Local preview generation is template-based. Only Pong currently becomes a playable prototype; other projects receive a static local brief until project-specific generators are added.
- Agent learning is local prompt memory, not fine-tuning.
- Uploaded file binaries are not retained after parsing.
- The purpose guardrail is deterministic and keyword based, so it may need refinement as use cases expand.

## Useful Commands

```bash
npm install
npm run dev:all
npm run lint
npm run build
```
