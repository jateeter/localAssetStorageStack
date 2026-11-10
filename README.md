# localAssetStorageStack
A local instantiation of the [dokieli](https://dokieli.github.io/) asset management system for use within the workflows of the Reality Engine suite.

## Components
| Service | Address (the same inside and outside the containers) | Purpose |
|---|---|---|
| `assets-css` | `https://assets-css.localhost:13443/` | Solid Community Server: authenticated storage of dokieli documents (PODs) |
| `assets-dokieli` | `https://assets-dokieli.localhost:13444/` | dokieli authoring/annotation UI (static build) |
| `lifecycle` | `https://lifecycle:8443/` on the network; a loopback host port from `runtime/registry.json` | Canonical lifecycle API (documents, assetID frames and their continuations, findings, dispositions) |

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
- **Before a frame is built, at every resume, and before every write,** the service reads the document again. A changed `ETag` or hash refuses the frame (`409 pod changed since pin`), takes the escape path at resume, or refuses the write; pin the edit as a new revision to carry on. Writes carry `If-Match: <pinned ETag>`.
- **Access.** `up.js` gives each person an `assets/` container (`scripts/grant-assets.js`). Its ACL gives the owner Read/Write/Control and the lifecycle WebID Read/Write, on the container and everything in it. Workflow documents are kept there. The rest of a pod stays private, and the service can't pin it (`409 … cannot read`).
- **History.** Every change is appended to `/data/events.jsonl` and fsynced before it is answered. Each line is chained to the one before by SHA-256, so a rewritten past is detected; the service refuses to start on a broken log. Read an asset's history at `GET /assets/:id/history`.
- **Receipts** are Ed25519 over the RFC 8785 canonical form. The public key is at `GET /keys` (open). Verify one offline with `node scripts/verify-receipt.js receipt.json keys.json`.

## The assetID frame and its continuations

An agentic dispatch acts on a **frame** (ROADMAP phase 4; RealityEngine_CI `docs/CONTINUATIONS_APPROVAL_CHAIN.md` is authoritative). The frame's id is the assetID the engines' clone route is given. It holds:
- its `documents`, registered assets pinned by revision, SHA-256 and ETag;
- `action`, `arguments` and `return`;
- the case keys (entity, period, asset type) that name its **workflow head**;
- `upstreamRefs`;
- its **continuation log**, append-only, with `current` naming the live record.

A pointer to the frame is written beside its primary document in the pod (D10).

- **Capture** (the engine side, after a step): records the next continuation. It names an engine instance and a template, never a clone. `park: true` waits for a person, and the head goes to IN_REVIEW.
- **Resume:** one-shot.
  - It checks the generation, and the principal the continuation names. Agents never resume, and a reviewer may not be the preparer.
  - It checks the pinned documents, and that the engine instance still carries the template (`RE_REGISTRY_URL`; without it, `engineCheck: "unchecked"` is reported).
  - Any failed check takes the **escape path**: the continuation is superseded, the frame re-enters at its `onStale` target, and the head goes STALE.
  - A person's resume is a decision (`approve` or `rework`) on the exact pinned revision.
  - An engine resume returns the step's agent capability once, scoped to the frame and that continuation.
- **Staleness:** pinning a new revision of a frame document or an upstream ref takes the escape path for every open frame that depends on it.
- **Abandon** needs the case's abandon capability: the preparer, or registrar automation, and never an agent or the engine side. **Close** is termination, and the workflow head closes with the frame. Each head holds one open frame at a time.
- **Agents never write a pod directly** (D5). Through `/pod` they read their own frame's documents (`pod:read`), and write them only with `pod:write`, under `If-Match` with the pinned ETag.

Every action is a log event and an Ed25519 receipt.

## The lifecycle as a PE Source: frame lanes

The template is the existing domain machine (owner, 2026-11-09; ROADMAP phase 6). When the engine side clones it for a frame's step, the clone carries the machine's input region in its block's input quarter. The cells the machine declares **reserved** (cells 2–7) become the frame's **lanes**. The lifecycle service manages them:

- **Allocation:** `POST /frames/:id/clones`, with the engine's clone `201`, after the step's continuation is resumed. It checks four things:
  - the clone is the step's template on the step's engine, for this assetID;
  - the cells lie in the clone band;
  - the template declares them reserved (asked of the engine);
  - no live allocation holds them.

  It then writes the frame's observations into them through a sensor source on that engine's PE.
- **Deallocation:** `DELETE /frames/:id/clones/:cloneId?generation=`, after recycle, and automatically on close or abandon. The allocation lives exactly as long as the clone.
- **The lanes,** each 1 while it holds:

  | cell | observation |
  |---|---|
  | 2 | the asset is in its workflow |
  | 3 | a frame document has been re-pinned |
  | 4 | approved |
  | 5 | rework requested, until the next step resumes |
  | 6 | a step is running |
  | 7 | the head is STALE |

  They're re-pushed after every change to the frame, before the change is answered. A PE that can't be reached is recorded on the allocation and in the log; it never fails the change.
- **One source per engine and block** (`lifecycle-<engine>-block-<k>`), declared once and kept. A PE keeps a removed source's last values, so freeing lanes writes zeros instead of removing the source; the next clone in that block starts clean.
- **The engines** come from the RealityEngine instance registry (`RE_REGISTRY_URL`), over lane mTLS. Without it, allocations are recorded `unwired` and nothing is sent.

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
- **services**: `Authorization: Bearer <service token>`, each token at least 32 bytes. `registrar` registers assets, `engine` runs frames' steps (RealityEngine_Manager's instantiation component), and `admin` manages roles and nothing else.
- **agents**: `Authorization: Bearer <capability>`, an EdDSA JWT this service issues for one frame step (D8): returned once, with the engine side's resume (or by `POST /frames/:id/continuations/:k/capability` for a step a person resumed), and valid only for that frame and step. Agents have no WebID.

Routes:
- `GET /health` (open)
- `GET /registry` (open; the stack's service addresses and the lifecycle host port)
- `POST /assets` / `GET /assets[/:id]` – register a CSS POD document; pins revision, hash, case, dependencies, authority (`podUrl` must be on `CSS_ORIGIN`)
- `POST /assets/:id/revisions` – pin new revision (existing machines become stale)
- `POST|GET /assets/:id/annotations` (reviewer) – dokieli annotations as revision-specific findings, authored by the caller's WebID
- `POST /assets/:id/dispositions` (reviewer) – decisions by the caller's WebID, one per reviewer per revision
- `GET|PUT /roles` (admin) – the role list; `PUT` takes `{ webId, roles }` and persists over `runtime/roles.json`
- `GET /whoami` – the caller as this service sees them
- `POST /frames` (engine, registrar) – build a frame and its first continuation `k0`; `GET /frames/:id`, `GET /frames/:id/history`, `GET /heads`
- `GET /frames?status=open` – the engine side's work list, each frame with its current continuation (RealityEngine_Manager's instantiation component reads it, and recovers from it after a restart)
- `POST /frames/:id/continuations/:k/capability` (engine) – the step capability of a continuation a person resumed (a reviewer's approve), issued once; an engine resume returns it with the resume
- `PUT /frames/:id/return` – the step's return (its agent, with the frame capability)
- `POST /frames/:id/continuations` (engine) – capture or park the next continuation
- `POST /frames/:id/continuations/:k/resume` – `{ generation, decision? }`: `resume` with `next` (and an agent capability for an engine resume), or `escape`
- `POST /frames/:id/continuations/:k/supersede` (engine), `POST /frames/:id/abandon` (the case's abandon capability), `POST /frames/:id/close` (engine; termination)
- `GET|PUT /pod?url=` – an agent's only way to its frame's documents
- `POST /frames/:id/clones` (engine) – allocate the frame's lanes in the clone's reserved cells; `DELETE /frames/:id/clones/:cloneId?generation=` – free them; `GET /lanes`
- `GET /assets/:id/history` – the asset's events from the append-only log
- `GET /keys` (open) – the receipt keys (JWKS)
- `GET /metrics` (open) – the workflow in aggregate, for Prometheus (ROADMAP phase 10). It carries frames, continuations and heads by status, parked continuations and the oldest one's age by resumer role and next template, reviews pending, and events committed by type. No frame, asset or person is a label.
- `GET /receipts/:id`, `POST /receipts/:id/verify` – the same check `scripts/verify-receipt.js` makes offline

Every event the service commits is also written to stdout as one JSON line (`"kind": "lifecycle.event"`, the line as the log holds it), unless `LIFECYCLE_EVENT_LINES=off`. RealityEngine_CI's Promtail picks up this stack's containers by their `org.realityengine.stack=localassetstoragestack` label and sends the lines to Loki, where its `asset-workflow` Grafana dashboard follows each asset through the workflow (ROADMAP phase 10).

OpenClaw agents (ROADMAP phase 8) and dokieli notifications (phase 5) are pending.

Known gaps and the plan to close them: [ROADMAP.md](ROADMAP.md), from the review in `docs/localAssetStorageStack Gaps.pdf`.

## Checks against a running universe

Both run against a stack this repo started (`node scripts/up.js`, or RealityEngine_CI's `startUniverse.sh --assets`). Run them with `node --dns-result-order=ipv4first` and `NODE_EXTRA_CA_CERTS` set to the lane CA. Each takes an optional report path.

- **`scripts/smoke.js`** checks four things:
  - every seeded pod and WebID is served, and registration is closed;
  - a pin read back from CSS (the lifecycle's ETag is CSS's);
  - a receipt verifies offline with `/keys` alone;
  - pod URL, WebID and the lifecycle's asset are the same after a restart.
- **`scripts/chain-regression.js`** runs the IFRS approval chain on every voting engine, with Manager running each step. It needs `RE_REGISTRY_URL`, `MANAGER_URL` and `RE_HARNESS_TLS_CA/CERT/KEY`.
  - IFRS_Sec01_GeneralPurposeFS_Verifier parks IFRS_Sec03_Compliance_Assertion_Arbiter for review, holding no block.
  - The preparer can't approve; the reviewer approves; a replay is refused.
  - The arbiter step terminates and closes the head.
  - A stale upstream takes the escape path.
  - `clone.maxActive + 1` shows the pool limit, and the pool is as it was after recycling.

  The three engines' outcomes must be identical (RealityEngine_CI#715). RealityEngine_CI's regression `asset-workflow` stage runs both.

## Test
`cd lifecycle && npm test` and `node --test scripts/*.test.js` (CI also validates compose and smoke-tests the container).
