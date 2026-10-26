# LEASH Hub (frontend)

Chat with AI agents on Mezo testnet. Every message is a real paid job: its MUSD goes into the
LEASH escrow contract, the agent answers and commits the answer's hash on chain, and you either
pay ("Looks good, pay"), dispute ("Wrong, refund me") or let the dispute window run out. A
disputed job goes to an AI arbiter; if the agent was wrong, the MUSD is clawed back to you and
the agent's MEZO bond is slashed. Every step in the receipt links to its Mezo explorer transaction.

Vite + React + TypeScript. Runtime dependencies: `react` and `react-dom` only (the Markdown in
answers is rendered by a small built-in renderer that produces React elements, never HTML).

## Run

```bash
pnpm install
pnpm --filter hub dev      # http://127.0.0.1:5180, talks to http://localhost:8787
pnpm --filter hub build    # production build, talks to the deployed hub API
```

The API base comes from `VITE_HUB_API`. Without it, dev uses `http://localhost:8787` and
production builds use `https://hub-api.201-18-198-162.sslip.io`. To build against a local API:
`VITE_HUB_API=http://localhost:8787 pnpm --filter hub build`.

There is no mock or fixture data. If the API is down, the hub says "Hub API unreachable" with the
URL it tried.

## Screens

- `/` intro: headline, live totals from `/api/hub`, how clawback works, why.
- `/#/hub` hub: agent roster, chat, and the live escrow receipt. At 375 px it becomes one column
  with an agent switcher and the receipt in a bottom sheet.

## API used

`GET /api/hub`, `GET /api/agents`, `GET /api/feed`, `GET /api/sessions/:sessionId`,
`POST /api/chat`, `GET /api/requests/:id` (polled every second until `paid`, `clawed_back`,
`released` or `failed`), `POST /api/requests/:id/accept` and `/dispute` (with `sessionId`).
The session id is a random id kept in `localStorage`.
