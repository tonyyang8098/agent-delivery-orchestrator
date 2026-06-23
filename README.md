# Agent Delivery Orchestrator

A local React and Node prototype for coordinating AI-assisted feature delivery across dev, stage, and prod.

The UI models four agents:

- Business analyst agent
- Software agent
- Tester agent
- DevOps agent

The workflow covers feature intake, planning, code build, QA, code check-in, pull request creation, human PR merge, dev deployment, stage deployment, human production approval, and production deployment.

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

New feature work starts with a Business Analyst clarification loop:

1. The user enters the feature or tool request.
2. The Business Analyst agent asks one clarifying question at a time.
3. The user answers until the BA determines the baseline requirements are complete.
4. The BA creates a baseline requirements document.
5. The developer pipeline starts from that baseline and hands work to the Software, Tester, and DevOps agents.

After the baseline exists, the BA chat stays open. The user can ask the BA to expand scope, add features, modify requirements, or delete existing features. Each accepted change creates a new baseline requirements document version and makes that version the active baseline for the run.

The requirements chat is persisted in the active in-memory run and is exposed through:

```text
POST /api/runs/:runId/requirements/messages
```

## LLM Persona Setup

The backend owns all LLM calls. The browser never receives the API key.

Create a local `.env` file from the example:

```bash
cp .env.example .env
```

Set:

```text
OPENAI_API_KEY=your_api_key_here
OPENAI_MODEL=gpt-5.5
```

When `OPENAI_API_KEY` is present, each workflow step calls the OpenAI Responses API with the persona assigned to that step:

- Business Analyst agent
- Software agent
- Tester agent
- DevOps agent

When `OPENAI_API_KEY` is missing, the API automatically uses mock persona output so the local workflow remains testable.

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
