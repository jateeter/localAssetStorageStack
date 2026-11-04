# localAssetStorageStack
A local instantiation of the [dokieli](https://dokieli.github.io/) asset management system for use within the workflows of the Reality Engine suite.

## Components
| Service | Port (localhost) | Purpose |
|---|---|---|
| `css` | 3000 | Solid Community Server: authenticated storage of dokieli documents (PODs) |
| `dokieli` | 8081 | dokieli authoring/annotation UI (static build) |
| `lifecycle` | 8080 | Canonical lifecycle API (documents, review machines, bindings, findings) |

All join the external-by-name Docker network `reality-engine`, so the localAIStack / localOpenClawStack services can reach them.

## Run
```
cp .env.example .env   # fill in tokens (>=16 chars) and RECEIPT_SECRET
docker compose up -d --build
```

## Lifecycle API (Bearer-token auth; roles: registrar, engine, agent, reviewer, admin)
- `GET /health` (open)
- `POST /assets` / `GET /assets[/:id]` – register a CSS POD document; pins revision, hash, case, dependencies, authority (`podUrl` must be on `CSS_ORIGIN`)
- `POST /assets/:id/revisions` – pin new revision (existing machines become stale)
- `POST /assets/:id/machines` – instantiate a review machine from a guardrail class; `POST /machines/:id/verify` verifies the manifest hash before admission; `POST /machines/:id/revoke`
- `POST /machines/:id/bindings` (engine) – step-binding receipt connecting ISRE snapshot, OSRE output, exact revision, generation and scoped context grant; stale revision/generation rejected
- `POST /bindings/:id/proposals` (agent) – immutable proposal, validated, committed with signed receipt
- `POST|GET /assets/:id/annotations` – dokieli annotations as revision-specific findings
- `POST /assets/:id/dispositions` – reviewer decisions (one per reviewer per revision)
- `GET /receipts/:id`, `POST /receipts/:id/verify`

Runtime integration with ISRE/OSRE, PE, and OpenClaw is pending; this repo provides the contracts and service.

## Test
`cd lifecycle && npm test` (CI also validates compose and smoke-tests the container).
