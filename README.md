
# Hermes on PostgreSQL + Synapse Agent (Groq + Tools)
Single **server.js** runs APIs, WebSocket, and serves four simple React dashboards (Customer/Partner have maps).


## Architecture diagram 
![IMG-20250817-WA0016_1755432468467](https://github.com/user-attachments/assets/c874614c-f6bc-4cbf-9f0d-ab0439089ab2)


## Install & Run
```bash
cp .env.example .env
npm install
npx prisma generate
npx prisma migrate dev --name init
npm run db:seed
npm run install:all
npm run build:ui
npm start
# http://localhost:3000
```

Env flags:
- `USE_MOCK=1` → deterministic routing, no external calls.
- `GROQ_API_KEY` → enables LLM planning (falls back to heuristics if missing).
- `AGENT_MAX_STEPS`, `AGENT_MIN_INTERVAL_MS` → guardrails.

## Paths
- Merchant: /merchant
- Partner:  /partner
- Customer: /customer
- Ops:      /ops

**Windows tip:** If you see a Prisma schema error, run `npx prisma format` once to normalize line endings.
