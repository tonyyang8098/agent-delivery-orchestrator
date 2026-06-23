# Agent Delivery Orchestrator

A local React prototype for coordinating AI-assisted feature delivery across dev, stage, and prod.

The UI models four agents:

- Business analyst agent
- Software agent
- Tester agent
- DevOps agent

The workflow covers feature intake, planning, code build, QA, code check-in, pull request creation, human PR merge, dev deployment, stage deployment, human production approval, and production deployment.

## Local Development

```bash
npm install
npm run dev
```

Open the local URL printed by Vite. The current dev server is configured to run on:

```text
http://127.0.0.1:5173/
```

## Validation

```bash
npm run lint
npm run build
```
