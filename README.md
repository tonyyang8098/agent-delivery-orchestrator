# Agent Delivery Orchestrator

A local React and Node prototype for coordinating AI-assisted feature delivery across dev, stage, and prod.

The UI models five agents:

- Business analyst agent
- Architect agent
- Software agent
- Tester agent
- DevOps agent

The workflow covers feature intake, parallel architecture design and user story creation, developer handoff, code build, QA, code check-in, pull request creation, human PR merge, dev deployment, stage deployment, human production approval, and production deployment.

## Local Development

```bash
npm install
npm run dev:all
```

The local services run on:

```text
UI:  http://127.0.0.1:5173/
API: http://127.0.0.1:3001/
```

The backend is an in-memory Express API. It owns the active run state, advances simulated agent work, pauses at human approval gates, and exposes endpoints for UI polling and operator actions.

## Requirements Intake

New feature work starts with a named project and a Business Analyst clarification loop:

1. The user enters the project name. The backend normalizes it into the GitHub-ready repository name for the run.
2. The user enters the feature or tool request.
3. The Business Analyst agent asks one clarifying question at a time.
4. The user answers until the BA determines the baseline requirements are complete.
5. The BA creates a baseline requirements document.
6. The Architect agent designs the solution while the BA creates user stories in the same parallel planning gate.
7. The orchestrator waits until both design and stories are finalized.
8. The orchestrator hands developer-ready stories and technical notes to the Software, Tester, and DevOps agents.

The DevOps agent prepares the repository path for three long-lived environment branches:

- `dev`: lowest environment and the base for feature work
- `stage`: promoted from `dev` for release validation
- `prod`: promoted from `stage` after human production approval

The pull request target is `dev`; promotion then flows `dev -> stage -> prod`.

After the baseline exists, the BA chat stays open. The user can ask the BA to expand scope, add features, modify requirements, or delete existing features. Each accepted change creates a new baseline requirements document version and makes that version the active baseline for the run.

The active baseline is treated as the shared context file for the team. Each downstream agent receives it as `baseline-requirements.md` when producing architecture, user stories, implementation, QA, repository, or deployment handoffs. Developer handoff and build work stay blocked until the parallel design/story gate completes.

The intake form also accepts context files when starting a run:

- Requirement documents: `.txt`, `.md`, `.docx`
- Sample datasets: `.csv`, `.xlsx`

Uploads are parsed in memory by the local backend. Requirement documents are converted into extracted text context, and datasets are converted into row/column summaries plus a small preview. The extracted context is included in BA clarification, baseline generation, architecture design, user stories, and downstream handoffs. Uploaded file binaries are not written to disk or committed to Git.

The backend enforces a purpose guardrail before starting a run or accepting BA chat messages. Inputs must be related to software delivery work: feature or tool requests, requirements, scope changes, architecture, implementation, QA, repository operations, or deployment. Random questions and general assistant tasks are rejected before they can enter the agent workflow.

The requirements chat is persisted in the active in-memory run and is exposed through:

```text
POST /api/runs/:runId/requirements/messages
```

## Agent Teamwork And Learning

Agents now specialize and review each other through their own lens:

- Business Analyst checks scope and acceptance alignment.
- Architect checks system boundaries, data flow, dependencies, and technical tradeoffs.
- Software checks implementation feasibility and maintainability.
- Tester checks acceptance coverage, regressions, and edge cases.
- DevOps checks PR, environment, deployment, rollback, and release evidence.

When the BA creates or revises the baseline, the other agents review it before developer handoff. When a workflow step completes, the non-author agents review each handoff and create peer review records with `approved`, `watch`, or `changes-requested` status.

The backend also keeps local agent memory in `local-state/agent-memory.json`. This file is ignored by Git so the agents can learn from local runs without uploading runtime memory to GitHub. Memory is used in future prompts and visible in the UI as handoff counts, review counts, and the latest learned pattern for each specialist.

## LLM Persona Setup

The backend owns all LLM calls. The browser never receives the API key.

Create a local `.env` file from the example:

```bash
cp .env.example .env
```

Set:

```text
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=gpt-4.1-mini
LLM_REQUIRE_APPROVAL=true
LLM_MAX_OUTPUT_TOKENS=300
CONTEXT_FILE_LIMIT=6
CONTEXT_FILE_MAX_BYTES=5242880
```

When `OPENAI_API_KEY` is present, each workflow step calls the OpenAI Responses API with the persona assigned to that step:

- Business Analyst agent
- Architect agent
- Software agent
- Tester agent
- DevOps agent

When `OPENAI_API_KEY` is missing, the API automatically uses mock persona output so the local workflow remains testable.

## LLM Cost Controls

The local backend is conservative by default:

- `OPENAI_MODEL` defaults to `gpt-4.1-mini`.
- `LLM_REQUIRE_APPROVAL` defaults to `true`, so the API pauses before every paid LLM call.
- `LLM_MAX_OUTPUT_TOKENS` defaults to `300`, keeping persona responses short.
- Every pending LLM call shows estimated input tokens, maximum output tokens, and estimated total cost in the UI.
- The operator can approve the paid call or choose mock output for `$0`.

The approval endpoints are:

```text
POST /api/runs/:runId/llm/approve
POST /api/runs/:runId/llm/mock
```

Cost estimates are guardrails for local budget control. The actual provider bill depends on the final model pricing and token usage returned by the API.

Run the services separately if needed:

```bash
npm run api
npm run dev
```

## Validation

```bash
npm run lint
npm run build
```
