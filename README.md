# localAssetStorageStack
A local instantiation of the [dokieli](https://dokieli.github.io/) asset management system for use within the workflows of the Reality Engine suite.

## Components
| Service | Address (the same inside and outside the containers) | Purpose |
|---|---|---|
| `assets-css` | `https://assets-css.localhost:13443/` | Solid Community Server: authenticated storage of dokieli documents (PODs) |
| `assets-dokieli` | `https://assets-dokieli.localhost:13444/` | dokieli authoring/annotation UI (static build) |
| `lifecycle` | `https://lifecycle:8443/` on the network; a loopback host port from `runtime/registry.json` | Canonical lifecycle API (documents, review machines, bindings, findings) |

**Every link is TLS 1.3** (RealityEngine_CI#668): the profile's suites, `X25519MLKEM768` key exchange, certificates from the suite's PKI (RealityEngine_CI `scripts/lib/re_pki.py`). No service has a plaintext listener: plain HTTP to any port gets no reply. The lifecycle service refuses to start without its certificate and accepts only `https` pod URLs. Two of the ports are fixed (ROADMAP D7) because a pod's URL includes its port; `up.js` fails, naming the holder, if one is taken.

lifecycle → `assets-css` is TLS 1.3 **without mTLS**, because CSS does not verify client certificates. That is a recorded, owner-accepted deficiency (RealityEngine_CI `config/transport-inventory.json`). Solid-OIDC with DPoP-bound tokens authenticates the lifecycle service instead (ROADMAP phase 2).

All services join the external-by-name Docker network `reality-engine`, so localAIStack / localOpenClawStack services can reach them at these stable container addresses. Create the network once if it does not already exist:

```
docker network create reality-engine
```

## Run
```
cp .env.example .env   # fill in tokens (>=16 chars) and RECEIPT_SECRET
node scripts/up.js
```

`node scripts/up.js` replaces `docker compose up -d --build`. It needs RealityEngine_CI checked out beside this repository, or `RE_PKI` pointing at its `scripts/lib/re_pki.py`. It:
1. issues the three services' certificates from the suite's PKI (lane `$RE_PKI_LANE`, default `native`) and links them under `runtime/pki/` (gitignored), where the services mount them read-only;
2. checks that 13443 and 13444 are free, and fails naming the holder if not;
3. starts the stack and waits for every healthcheck. Each healthcheck verifies its service's certificate against the install CA.

Other compose commands (`ps`, `logs`, `exec`, `down`) work as usual. All ports are bound to `127.0.0.1`.

The script then writes `runtime/registry.json`, this stack's own service file (not the RealityEngine instance registry), with each service's `internalUrl` and `externalUrl` and the CA path. The lifecycle API serves the same file at `GET /registry`. It is runtime state and is never committed.

**Trusting the CA.** Browsers need the install CA once; that is the owner's step, and `up.js` prints the command. Tools must speak TLS 1.3: macOS's `/usr/bin/curl` (SecureTransport) cannot, so use Homebrew's curl (`/opt/homebrew/opt/curl/bin/curl --cacert …`).

## Lifecycle API (Bearer-token auth; roles: registrar, engine, agent, reviewer, admin)
- `GET /health` (open)
- `GET /registry` (open; the stack's service addresses and the lifecycle host port)
- `POST /assets` / `GET /assets[/:id]` – register a CSS POD document; pins revision, hash, case, dependencies, authority (`podUrl` must be on `CSS_ORIGIN`)
- `POST /assets/:id/revisions` – pin new revision (existing machines become stale)
- `POST /assets/:id/machines` – instantiate a review machine from a guardrail class; `POST /machines/:id/verify` verifies the manifest hash before admission; `POST /machines/:id/revoke`
- `POST /machines/:id/bindings` (engine) – step-binding receipt connecting ISRE snapshot, OSRE output, exact revision, generation and scoped context grant; stale revision/generation rejected
- `POST /bindings/:id/proposals` (agent) – immutable proposal, validated, committed with signed receipt
- `POST|GET /assets/:id/annotations` – dokieli annotations as revision-specific findings
- `POST /assets/:id/dispositions` – reviewer decisions (one per reviewer per revision)
- `GET /receipts/:id`, `POST /receipts/:id/verify`

Runtime integration with ISRE/OSRE, PE, and OpenClaw is pending; this repo provides the contracts and service.

Known gaps and the plan to close them: [ROADMAP.md](ROADMAP.md), from the review in `docs/localAssetStorageStack Gaps.pdf`.

## Test
`cd lifecycle && npm test` (CI also validates compose and smoke-tests the container).
