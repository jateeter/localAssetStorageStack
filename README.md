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

## Identity

Registration on `assets-css` is **closed** (ROADMAP phase 2): nobody can create an account or a pod from the web. The only accounts are the ones `up.js` seeds:
- **`lifecycle`**: the lifecycle service's own WebID. At start the service signs in with its seeded password, creates DPoP client credentials once, keeps them on its data volume (0600) and reports them on `/health` (`identity.status: ready`).
- **People**, from `ASSETS_PEOPLE` (`name:role[+role],...`, default `author:author,reviewer:reviewer`). Each gets a pod and a WebID, `https://assets-css.localhost:13443/<name>/profile/card#me`, and the roles listed. The roles are written to `runtime/roles.json`, which the lifecycle service reads at start.

Passwords are generated once, into `.secrets/accounts.json` (gitignored, 0600). A rerun keeps them and seeds anyone newly added to `ASSETS_PEOPLE`. Removing someone from it takes away their roles but keeps their pod. If the pod store outlives `.secrets/`, `up.js` refuses to start: restore `.secrets/`, or start over with `docker compose down -v`.

People sign in to dokieli with **Solid-OIDC** against `assets-css`: in dokieli, Sign in → Sign in with Solid → `https://assets-css.localhost:13443/`. After that, dokieli reads and writes their pod directly. CSS answers CORS only for the dokieli origin.

## Integrity

The lifecycle service pins **what the pod holds**, never what it is sent (ROADMAP phase 3):
- **Pinning.** Registering an asset or a revision makes the service read the document itself, with its own DPoP identity. It records the `ETag` and the SHA-256 of the exact bytes. A registrar may send the `hash` it expects, which must match (`409` otherwise). It may not send `content`.
- **Before every binding, and before publish,** the service reads the document again. A changed `ETag` or hash is refused with `409 pod changed since pin`. Pin the edit as a new revision to carry on. Writes carry `If-Match: <pinned ETag>`.
- **Access.** `up.js` gives each person an `assets/` container (`scripts/grant-assets.js`). Its ACL gives the owner Read/Write/Control and the lifecycle WebID Read/Write, on the container and everything in it. Workflow documents are kept there. The rest of a pod stays private, and the service can't pin it (`409 … cannot read`).
- **History.** Every change is appended to `/data/events.jsonl` and fsynced before it is answered. Each line is chained to the one before by SHA-256, so a rewritten past is detected; the service refuses to start on a broken log. Read an asset's history at `GET /assets/:id/history`.
- **Receipts** are Ed25519 over the RFC 8785 canonical form. The public key is at `GET /keys` (open). Verify one offline with `node scripts/verify-receipt.js receipt.json keys.json`.

All services join the external-by-name Docker network `reality-engine`, so localAIStack / localOpenClawStack services can reach them at these stable container addresses. Create the network once if it does not already exist:

```
docker network create reality-engine
```

## Run
```
cp .env.example .env   # fill in the service tokens (>= 32 bytes); optionally ASSETS_PEOPLE
node scripts/up.js
```

`node scripts/up.js` replaces `docker compose up -d --build`. It needs RealityEngine_CI checked out beside this repository, or `RE_PKI` pointing at its `scripts/lib/re_pki.py`. It:
1. issues the three services' certificates from the suite's PKI (lane `$RE_PKI_LANE`, default `native`) and links them under `runtime/pki/` (gitignored), where the services mount them read-only;
2. checks that 13443 and 13444 are free, and fails naming the holder if not;
3. provisions the seeded accounts and the role list (see Identity);
4. starts the stack and waits for every healthcheck. Each healthcheck verifies its service's certificate against the install CA.

Other compose commands (`ps`, `logs`, `exec`, `down`) work as usual. All ports are bound to `127.0.0.1`.

The script then writes `runtime/registry.json`, this stack's own service file (not the RealityEngine instance registry), with each service's `internalUrl` and `externalUrl` and the CA path. The lifecycle API serves the same file at `GET /registry`. It is runtime state and is never committed.

**Trusting the CA.** Browsers need the install CA once; that is the owner's step, and `up.js` prints the command. Tools must speak TLS 1.3: macOS's `/usr/bin/curl` (SecureTransport) cannot, so use Homebrew's curl (`/opt/homebrew/opt/curl/bin/curl --cacert …`).

## Lifecycle API

Every caller is one of three kinds of principal (ROADMAP phase 2):
- **people**: `Authorization: DPoP <token>` plus a `DPoP` proof. The token must come from `assets-css`, be DPoP-bound (`cnf.jkt`), be fresh, and have `aud` including `solid`. The proof must be for this method and URL and is accepted once. The principal is the token's WebID, with roles (`author`, `reviewer`) from the role list. A body field naming a person (`reviewer`, `author`) is refused unless it names the caller.
- **services**: `Authorization: Bearer <service token>`, each token at least 32 bytes. `registrar` registers assets, `engine` creates bindings, and `admin` manages roles and nothing else.
- **agents**: `Authorization: Bearer <capability>`, an EdDSA JWT this service issues for one binding (D8). It is returned once, in the binding's creation response, and is valid only for that binding's proposals. Agents have no WebID.

Routes:
- `GET /health` (open)
- `GET /registry` (open; the stack's service addresses and the lifecycle host port)
- `POST /assets` / `GET /assets[/:id]` – register a CSS POD document; pins revision, hash, case, dependencies, authority (`podUrl` must be on `CSS_ORIGIN`)
- `POST /assets/:id/revisions` – pin new revision (existing machines become stale)
- `POST /assets/:id/machines` – instantiate a review machine from a guardrail class; `POST /machines/:id/verify` verifies the manifest hash before admission; `POST /machines/:id/revoke`
- `POST /machines/:id/bindings` (engine) – step-binding receipt connecting ISRE snapshot, OSRE output, exact revision, generation and scoped context grant, plus the agent's `capability`; stale revision/generation rejected
- `POST /bindings/:id/proposals` (agent, with that binding's capability) – immutable proposal, validated, committed with signed receipt
- `POST|GET /assets/:id/annotations` (reviewer) – dokieli annotations as revision-specific findings, authored by the caller's WebID
- `POST /assets/:id/dispositions` (reviewer) – decisions by the caller's WebID, one per reviewer per revision
- `GET|PUT /roles` (admin) – the role list; `PUT` takes `{ webId, roles }` and persists over `runtime/roles.json`
- `GET /whoami` – the caller as this service sees them
- `GET /assets/:id/history` – the asset's events from the append-only log
- `GET /keys` (open) – the receipt keys (JWKS)
- `GET /receipts/:id`, `POST /receipts/:id/verify` – the same check `scripts/verify-receipt.js` makes offline

Runtime integration with ISRE/OSRE, PE, and OpenClaw is pending; this repo provides the contracts and service.

Known gaps and the plan to close them: [ROADMAP.md](ROADMAP.md), from the review in `docs/localAssetStorageStack Gaps.pdf`.

## Test
`cd lifecycle && npm test` and `node --test scripts/*.test.js` (CI also validates compose and smoke-tests the container).
