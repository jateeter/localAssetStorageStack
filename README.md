# localAssetStorageStack
A local instantiation of the [dokieli](https://dokieli.github.io/) asset management system for use within the workflows of the Reality Engine suite.

## Components
| Service | Container address | Purpose |
|---|---|---|
| `css` | `http://css:3000` | Solid Community Server: authenticated storage of dokieli documents (PODs) |
| `dokieli` | `http://dokieli:8080` | dokieli authoring/annotation UI (static build) |
| `lifecycle` | `http://lifecycle:8080` | Canonical lifecycle API (documents, review machines, bindings, findings) |

All services join the external-by-name Docker network `reality-engine`, so localAIStack / localOpenClawStack services can reach them at these stable container addresses. Create the network once if it does not already exist:

```
docker network create reality-engine
```

## Run
```
cp .env.example .env   # fill in tokens (>=16 chars) and RECEIPT_SECRET
node scripts/up.js
```

`node scripts/up.js` replaces the previous `docker compose up -d --build` startup command. It selects a currently available, random loopback host port for each service, passes those ports to Compose, and starts or rebuilds the stack. The ports are bound to `127.0.0.1`, not exposed on external interfaces. Because ports are chosen at startup, do not assume fixed host ports; rerun the script after stopping/recreating the stack to refresh the allocation and registry.

On startup the script writes `runtime/registry.json` with each service's stable Docker-network `internalUrl` and dynamically assigned host `externalUrl`. The lifecycle API serves the same registry without authentication at `http://lifecycle:8080/registry` to services on the shared Docker network. Host-side tools should first discover the lifecycle host port from `runtime/registry.json`; the script prints the resulting lifecycle registry URL. MCP/ACP adapters and other suite services can read the registry to discover endpoints rather than hardcoding host ports. The Solid server's public base URL is also set to its assigned host URL. The generated registry is runtime state and must not be committed.

## Lifecycle API (Bearer-token auth; roles: registrar, engine, agent, reviewer, admin)
- `GET /health` (open)
- `GET /registry` (open; dynamically assigned host URLs and Docker-network service URLs)
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
