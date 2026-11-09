# localAssetStorageStack — Implementation Roadmap

Last reviewed: 2026-11-06

## Where the project stands

This repo runs three containers: a Solid Community Server (CSS), the dokieli
authoring UI, and a document lifecycle API (`lifecycle/`, 265 lines of Node,
9 tests). It is in the RealityEngine focus set and in scope for
`release-v0.0.2` (RealityEngine_CI#706, owner 2026-11-04).

The review in [`docs/localAssetStorageStack Gaps.pdf`](docs/localAssetStorageStack%20Gaps.pdf)
lists sixteen findings. Each was checked against the code at `05eefe2` and
holds. In short:

- pod addresses change on every start;
- nothing the service pins is read from the pod;
- an agent can publish without a reviewer;
- identity is five shared tokens;
- the review rules are a second rules engine beside the RE.

This file gives a solution for each finding (the finding numbers are the PDF's)
and orders the solutions into milestones.

## Decisions this roadmap rests on

| | Decision | Status |
|---|---|---|
| D1 | **Several CSS instances, each at its own address.** This stack's CSS is not PIM's and is never merged with it. Only the CSS *image version* is unified (RealityEngine_CI#707). | owner, 2026-11-04 |
| D2 | **All data in motion is encrypted, TLS 1.3, loopback included** (RealityEngine_CI#668). A pod's address includes its scheme, so the stack moves to `https` in the *same* change that fixes its addresses (A1). Otherwise every WebID and ACL changes twice. | owner, 2026-10-30 |
| D3 | **The IFRS `document_workflow` model is the lifecycle for IFRS documents** (entity + period + asset type; `DRAFT`/`IN_REVIEW`/`APPROVED`/`STALE`; `evidenceRefs`/`upstreamRefs`; `expectedRevision`), and this service is its Solid-backed repository. **Other domains will have other workflows**, so the service holds a workflow per domain and never builds IFRS into its core. | owner, 2026-11-04 |
| D4 | **The rules live in the corpus.** Each domain's workflow is a template in `RealityEngine_Machines`, instantiated per asset. The engine instance running that instance decides transitions. A template is proven in regression on identical corpora before it ships. The lifecycle service decides no workflow transition, and `GUARDRAIL_CLASSES` is removed once instantiation works. | owner, 2026-11-04 (closed; localAssetStorageStack#8) |
| D5 | **Agents never write a pod directly.** Every pod write goes through the lifecycle service, which checks the binding's scopes. Scopes are enforced at that one point; no ACL is edited per binding. This may change as the lifecycle service evolves. | owner, 2026-11-04 |
| D6 | **The lifecycle service is a store and gatekeeper only.** A separate instantiation component instantiates workflow machines and generates their agents; the service neither instantiates nor decides transitions. | owner, 2026-11-04 |
| D7 | **Fixed ports:** `assets-css` at `https://assets-css.localhost:13443/` and `assets-dokieli` at `https://assets-dokieli.localhost:13444/`. They differ from PIM's `13000`, and no other repo uses them. | owner, 2026-11-06 |
| D8 | **Agents act under the lifecycle service's agent principal** with frame-scoped capability tokens, not a WebID per agent. | owner, 2026-11-06 |
| D9 | **Reviewer decisions go through the authenticated lifecycle API;** dokieli is for authoring and annotation. **The asset workflow is tracked in a new Grafana dashboard.** | owner, 2026-11-06 |
| D10 | **Parked continuations live in the lifecycle service,** in its append-only event log, with the pod holding a pointer. **No step chooses its successor beyond the PE's ISRE folding.** | owner, 2026-11-06 |
| D11 | **Termination closes the head of the workflow.** A document-workflow template's completion is the close of its canonical workflow head. | owner, 2026-11-06 |
| D12 | **The whole assetID integration is in `release-v0.0.2`,** the engine, OpenClaw and Manager phases included. | owner, 2026-11-06 |

D3 decides the data model, so A3 builds on it directly. A3 and A5 both
rewrite the store and its routes; doing them in the wrong order means doing
them twice. D4 does not block A3–A5: the storage invariants they add hold
whatever the workflow template says.

### Workflows per domain (D3)

IFRS is the first workflow, not the only one. The service is therefore split
into two layers:

- **Core, the same for every domain:**
  - assets keyed by domain, entity, period and asset type;
  - pinned revisions with `expectedRevision`;
  - pod read-back;
  - the event log and receipts;
  - identity, scopes and the independent-approval gate;
  - dependency propagation.
- **Workflow, one per domain:**
  - its statuses and transitions;
  - its asset catalog;
  - its guards.

  IFRS's comes from `document_workflow.py` and `document-asset-catalog.json`.
  A domain without one can't register assets.

Two rules hold in every workflow, because they are core:

- an approval is on an exact revision by someone other than its author;
- a changed upstream marks its dependents stale.

A workflow is declared as corpus machines that the instantiation component
instantiates (#8). Until that lands, it is a data file the service loads,
never code.

## Solutions by finding

### Blocking

**1. Pod addresses change every run.**
- Give this stack's CSS one permanent address, the same inside and outside the
  containers: `https://assets-css.localhost:<ASSETS_CSS_PORT>/`, with `ASSETS_CSS_PORT` = `13443` (D7).
  - `ASSETS_CSS_PORT` is fixed per install, with a default that differs from
    PIM's `13000`.
  - The service is renamed from `css` to `assets-css`. The generic name is
    ambiguous once several CSS instances share a host (D1).
  - The container listens on that port and publishes it on `127.0.0.1` at the
    *same* port.
  - The container carries the network alias `assets-css.localhost`.
  - `*.localhost` resolves to loopback on the host, so a browser, dokieli and
    a container all use one URL. This is the pattern PIM already uses for its
    own `css.localhost`.
- `up.js` keeps choosing random ports only for the host-side dokieli and
  lifecycle links. It never changes `-b`, the CSS base URL. If the CSS port is
  taken, it fails and names who holds it; it never moves the port.
- The lifecycle service gets its pod origin (`CSS_ORIGIN`) from the same
  setting, so the origin it accepts is the one CSS hands out.
- A test starts the stack twice and checks that one pod's URL and WebID are the
  same both times.

**2. The lifecycle service never reads the pod.**
- The service gets its own Solid identity:
  - a WebID and client credentials in this CSS;
  - provisioned idempotently at first start, the way PIM's
    `scripts/provision-css.mjs` does;
  - stored in a secret volume, never in `.env`.
- It authenticates with a DPoP-bound token.
- `pin()` no longer trusts a hash it is sent:
  - it `GET`s `podUrl` itself and records the response's `ETag` and the
    SHA-256 of the exact bytes it received;
  - a registrar-supplied hash, if given, must match, or the call is refused
    (409).
- Before a binding, and again before `publish`, it reads the pod back:
  - a changed `ETag` or hash fails with `409 pod changed since pin`;
  - when it writes, it sends `If-Match: <pinned ETag>`.

**3. An agent can publish with no reviewer.**
- Entering `publish`, the only state that carries `pod:write`, requires an
  `approve` disposition:
  - on the exact revision *and* hash;
  - from a reviewer WebID that is not the revision's author;
  - with no `reject` or `rework` on that revision.
- An agent's `next` can no longer name `publish`. The service performs the
  transition only when the gate passes, and records the approving disposition
  in the publish receipt.
- In D3's terms this is `IN_REVIEW → APPROVED`, which the IFRS model already
  forbids to drafting agents.

**4. Identity is five shared role tokens.**
- People are WebIDs. CSS is already an OIDC provider, so the service accepts
  Solid-OIDC tokens and takes the principal from the token, never from the
  request body. `reviewer` and `author` stop being free text.
- Roles attach to WebIDs, in a role list the service reads at start.
- Service tokens remain for services only (engine, registrar automation). They
  are at least 32 bytes long and are rotated by re-provisioning.
- `admin` stops implying every role. It can manage roles and revoke machines,
  nothing else. No principal holds two of author, agent and reviewer on the
  same revision.
- One decision per reviewer per revision is then keyed by WebID, so a second
  name can't be invented.

### Serious

**5. Access scopes aren't enforced.**
- Scopes are enforced per D5:
  - a binding returns a short-lived capability token (JWT, `EdDSA`) that names
    the binding, the scopes and the pod URL, and expires when the binding
    closes;
  - pod reads and writes go through the service's `/pod` proxy, which checks
    that token;
  - `rag:read` is passed to localAIStack as the same token, and localAIStack
    checks it.
- `beacon` is defined or dropped. Unless someone names what a beacon is by A5,
  `beacon:read` is removed from the scopes.
- CSS registration is closed:
  - no `identity/access/public.json`; accounts are created by provisioning
    only;
  - pod ACLs grant write to the lifecycle service's WebID, and read to named
    reviewer WebIDs.
- Networks are split:
  - CSS and the lifecycle service share a private `assets-internal` network;
  - only the lifecycle service joins `reality-engine`;
  - so OpenClaw and localAIStack containers cannot reach CSS at all, only the
    lifecycle API.

**6. Receipts can't serve as outside evidence.**
- Receipts are signed with Ed25519 over the RFC 8785 (JCS) canonical form of
  the receipt minus its `signature` field.
- The signing key is generated at first start into the secret volume, and the
  public key is served at `GET /keys` (JWKS). Anyone can verify a receipt; only
  the service can issue one.
- Verification is cryptographic (`crypto.verify`), not string equality.
- Every hash the service records (`isre`, `osre`, `resultHash`, the manifest
  hash) is also taken over JCS, not `JSON.stringify`. That includes hashes
  inside receipts.
- Cross-language test vectors (`test/vectors/receipts.json`: inputs, canonical
  bytes, signature) are published so Lisp, C++ and Scala can verify the same
  receipts. A receipt from before the change is migrated by re-issuing it with
  its old id recorded, never by editing it in place.

**7. Storage isn't append-only.**
- `state.json` is replaced by an append-only event log:
  - JSON Lines in `lifecycle-data`;
  - one `write` plus `fsync` per event, and the directory fsynced on create;
  - an exclusive lock file, so only one process can write;
  - each event carries the SHA-256 of the previous one, so an edited or
    removed line breaks the chain at start.
- State is rebuilt by replaying the log at start. Proposals and receipts live
  only as events, so there is nothing to edit in place. `Object.freeze` goes
  away.
- Revisions follow the IFRS model:
  - a revision is the next integer for its asset;
  - every new revision must carry `expectedRevision`, the current one, and a
    mismatch is `409`, so two registrars can't overwrite each other;
  - a duplicate content hash returns the existing revision, as
    `document_workflow.py`'s retry rule does, and never clears `STALE`.

**8. Dependencies are stored but never used.**
- `dependencies` become `upstreamRefs` (D3): references to other assets'
  `(assetTypeId, revision)`.
- A new revision or a `STALE` mark walks the dependency graph downstream:
  - every dependent asset is marked `STALE` with reason `upstream-revised`;
  - its machines are marked stale too;
  - each mark is an event.
- The graph must have no cycles. An `upstreamRefs` entry that would create one
  is refused.
- Assets carry `entityId` and `period`. The asset key is the same hash of
  `{entityId, period, assetTypeId}` that `document_workflow.py` uses, so the
  same document has the same key in both stores.

### Structural

**9. The review machine sits outside the engine.**
- Decided (D4, localAssetStorageStack#8). `GUARDRAIL_CLASSES` is removed, and
  each domain's review workflow becomes a template in `RealityEngine_Machines`:
  - in that domain (IFRS first);
  - listed in its manifest;
  - proven in regression, like every corpus machine, before it ships.
- The service then:
  - accepts a transition only as the OSRE output of an engine binding;
  - checks that the binding receipt is for the current machine generation;
  - keeps only the storage invariants: revision pinning, the review gate (3),
    scopes (5) and append-only history (7).
- At most one binding can be open per machine; a second is `409 binding open`.

**10. Nothing connects dokieli to the lifecycle service.**
- Each asset gets an inbox container in its pod. dokieli already sends
  annotations there as Linked Data Notifications.
- The lifecycle service subscribes to that inbox through CSS 7's Solid
  Notifications (WebSocket channel, with a startup sweep for anything missed).
- Each annotation becomes a finding:
  - for the revision the annotation targets;
  - its author is the WebID that wrote it, which CSS authenticated;
  - it records the annotation URL and the hash of its content.
- `POST /assets/:id/annotations` stays for tools other than dokieli, under the
  same WebID identity (4).
- A test drives an annotation from dokieli's notification format to a stored
  finding.

**11. It doesn't match the IFRS document model.**
- Per D3, this service becomes the Solid-backed implementation, for IFRS, of
  the store contract `document_workflow.py` defines (other domains bring their
  own workflows on the same core):
  - head, revision and event records;
  - the four statuses, the review and staleness guards, and `expectedRevision`.
- The contract is written down once, in RealityEngine_Machines beside
  `document_workflow.py`. Both stores are tested against the same cases, the
  33 lifecycle and observation-adapter tests replayed against this service's
  API.
- The 68 asset types come from `document-asset-catalog.json`, read at start
  and never copied into this repo.

### Build and operations

**12. Nothing is pinned.**
- dokieli is pinned to a tag or commit and installed with `npm ci`
  (localAssetStorageStack#5).
- Every base image (`community-server`, `node`, `nginx-unprivileged`) is pinned
  to an exact version.
- The CSS version is entered in RealityEngine_CI's
  `config/shared-service-versions.json` with PIM's (RealityEngine_CI#707).
- Node follows the suite's `.nvmrc` minor (localAssetStorageStack#6).

**13. Only the lifecycle container is hardened.**
- Every service gets `cap_drop: [ALL]` and `no-new-privileges`, and runs
  `read_only` with a `tmpfs` where it needs one (CSS needs only its data
  volume).
- CSS and dokieli get healthchecks.
- `depends_on` uses `condition: service_healthy`, so the lifecycle service
  waits for CSS.
- The containers run as non-root users.

**14. CI only tests the lifecycle service.**
- In this repo (kept minimal; localAssetStorageStack#6):
  - lifecycle tests;
  - `docker compose config -q`.
- In RealityEngine_CI, on the local lane:
  - build all three images (dokieli once #5 is fixed; RealityEngine_CI#706
    builds the lifecycle image today);
  - start the stack;
  - run a smoke test that provisions a pod and pins a revision read from CSS
    (2);
  - check the address is the same across a restart (1);
  - verify a receipt with the public key (6).

**15. No backup or export.**
- `scripts/backup.js` writes `css-data` and the lifecycle event log to one
  archive with a manifest (file list, SHA-256 per file, the event log's chain
  head). It takes a consistent copy by pausing writes on the lifecycle lock.
- `scripts/restore.js` restores into an empty install and checks the event
  chain.
- A test round-trips a backup into a fresh volume and compares the state
  rebuilt from the event log.

**16. Housekeeping.**
- Remove the CUDA patterns (`*.i`, `*.ii`, `*.gpu`, `*.ptx`, `*.cubin`,
  `*.fatbin`) from `.gitignore`.
- Add `.DS_Store`.

## Milestones

| | Milestone | Findings | Depends on | Release |
|---|---|---|---|---|
| **A0** | Build and hygiene: pins, hardening, healthchecks, CI in step, `.gitignore` | 12, 13, 14 (repo side), 16; #5, #6 | — | v0.0.2 |
| **A1** | Permanent address over TLS: `assets-css.localhost`, fixed port, `https`, private network | 1, 5 (network split) | A0, the RealityEngine_CI#668 certificate path | v0.0.2 |
| **A2** | Identity: the service's WebID and DPoP client, WebID principals, roles, closed registration, ACLs | 4, 5 (registration, ACLs) | A1 | v0.0.2 |
| **A3** | Integrity: read-back and ETag, Ed25519/JCS receipts and `/keys`, append-only event log, `expectedRevision` | 2, 6, 7 | A2 | v0.0.2 |
| **A4** | Review gate: publish only on an independent `approve` of the exact revision | 3 | A2, A3 | v0.0.2 |
| **A5** | Domain model: core/workflow split, IFRS as the first workflow, entity/period keys, `upstreamRefs` propagation, scope tokens and `/pod` proxy, `beacon` settled | 5 (scopes), 8, 11 | A3 | v0.0.2 |
| **A6** | Rules in the corpus: workflow templates instantiated per asset by Manager; `GUARDRAIL_CLASSES` removed once instantiation works | 9 | D4 (closed); #8 phases P1 and P3 | with #8's phases |
| **A7** | dokieli inbox → findings | 10 | A2, A3 | v0.0.2 |
| **A8** | Backup, restore and export | 15 | A3 | v0.0.2 |
| **A9** | Suite integration: `startUniverse.sh`/`stopUniverse.sh`, instance registry entry, release images and compose, local-lane smoke (14, CI side), ISRE/OSRE, PE and OpenClaw wiring | 14 (CI side) | A1–A5 | v0.0.2 |

### A6 follows #8

D4 was discussed in localAssetStorageStack#8 and closed (owner, 2026-11-04):
the rules live in the corpus. A6 lands with #8's phases: the template schema
(P1) and Manager's instantiation component (P3).

Until then, the hard-coded rules can't do much harm, because of A3 and A4:

- the rules can no longer publish without independent approval;
- every transition they make is on the record.

### The direction set so far (localAssetStorageStack#8, owner 2026-11-04)

Workflow machines are **instantiated dynamically, one set per asset**, from the
machine corpus, which serves as the class library. The work is split three
ways:

- **The lifecycle service (this repo): store and gatekeeper only (D6).** It
  holds:
  - the asset and its pinned, read-back revisions;
  - the append-only history and the receipts;
  - the asset pointer every agent uses (D5);
  - the rules every workflow must obey (approval, staleness, scopes).

  Its state changes (an asset entering its workflow, the workflow
  terminating) reach the engines as input: the service is a Source to the PE,
  and the changes enter through the ISRE.
- **A separate instantiation component, which starts instantiation and
  generation.** It hears about changes through the ISRE and acts through the
  OSRE: what it does is an action the engines' recognition calls for, never
  a direct reaction to the lifecycle service. When an asset enters its
  workflow, it:
  - loads a pinned machine version, through the current machine `POST`, on
    each engine instance whose corpus carries the template;
  - names each instance by template, engine instance (`cpp-1`) and an
    instance counter that survives restarts;
  - allocates one Source per instance;
  - generates and dynamically loads the workflow's ACP and MCP behaviors and
    the OpenClaw agents for both sides of each action (instigation from the
    OSRE, response back through the Source), all configured with the asset
    pointer.

  When the workflow terminates, it unloads and retires all of them. Instances
  scale with the number of assets in flight.
- **The engines:** the engine instance running a workflow instance decides
  its transitions.

The loop runs entirely through the engines:

> lifecycle change → Source → ISRE → recognition → OSRE → instantiation component

**Regression and deployment** (owner, 2026-11-04;
RealityEngine_CI `docs/ENGINEERING_CONTRACT.md`):

- **In deployment,** parity is not a goal. Engine instances commonly carry
  different corpora, so Manager instantiates a template only on the engine
  instances whose corpus carries it, all-or-nothing per engine instance.
- **In regression,** the same template, on the voting engines with identical
  corpora, must make the same decisions. That is where a template is proven.

The instantiation component lives in **RealityEngine_Manager** (owner,
2026-11-04); RealityEngine_CI has no role after deployment. Each engine
instance has its own instance counter. For this repo, the consequences are:

- **A5:** the service becomes a PE Source. Its workflow state changes are
  delivered as input observations, through the source integration contract
  the other PE sources use.
- **A6:** `GUARDRAIL_CLASSES` is removed once the instantiated machines decide
  transitions.

## assetID integration plan (release-v0.0.2)

This plan completes the assetID integration and turns on the interconnections:
- dokieli ↔ CSS;
- dokieli → the lifecycle service;
- the lifecycle service ↔ CSS;
- the lifecycle service ↔ the universe (ISRE, OSRE, the PEs, OpenClaw, Manager).

It rests on D1–D12 and on what is already specified:
- cloneable machines, the 64-cell nest block, block generations, and the
  two outbound paths: `RealityEngine_CI/SURFACE_SPEC.md`, "Cloneable machines";
- continuations: `RealityEngine_CI/docs/CONTINUATIONS_APPROVAL_CHAIN.md`;
- the corpus side: RealityEngine_Machines#243, #244.

**Every phase below is in `release-v0.0.2`** (D12), the engine, OpenClaw and
Manager phases included.

Each phase lands in its own repository, through a PR. "Verify" names what
proves it. A hosted check alone does not.

### Phases

**1. Stable, encrypted addresses** (A0 remainder, A1).
- **Status (2026-11-07): done** (localAssetStorageStack#15). The services are
  on TLS 1.3 with `X25519MLKEM768` at the fixed addresses. TLS 1.2 and
  plaintext are refused, a pod's URL and WebID are unchanged across a restart,
  and lifecycle → `assets-css` verifies against the install CA. That link has
  no mTLS (an owner-accepted deficiency: CSS can't verify client
  certificates). Closing CSS registration moves to phase 2.
- **CSS:** renamed `css` → `assets-css`, at
  `https://assets-css.localhost:13443/` (D7). The URL is the same inside the
  containers (network alias) and outside them, and the `-b` base URL never
  changes. `up.js` keeps random host ports only for the lifecycle link. If
  13443 or 13444 is taken, it fails and names the holder.
- **dokieli:** at `https://assets-dokieli.localhost:13444/` (D7). It must be
  https too: browsers refuse mixed content against an https pod.
- **TLS 1.3 on every link** (D2), with certificates from the
  RealityEngine_CI#668 certificate path.
- **Hardening:** `cap_drop`, `read_only`, non-root and healthchecks for CSS and
  dokieli; `depends_on: service_healthy`.
- **`up.js`:** stops calling its file the instance registry. It is this stack's
  service file.
- **Verify:**
  - start the stack twice: one pod URL and WebID are the same both times;
  - TLS 1.3 is checked on each link.

**2. Identity** (A2). Turns on dokieli ↔ CSS sign-in, and the lifecycle
service's identity on CSS.
- **Status (2026-11-09): done** (localAssetStorageStack#17). Both verify items
  pass live. In a real browser, a scripted Solid-OIDC login, then dokieli saves
  a document in the author's pod (PUT 201), and a fresh session reloads it
  (an anonymous read gets 401). Against real `assets-css` tokens, a forged
  `reviewer` field is refused (403), as are replayed and bearer-presented DPoP
  tokens. A restart keeps every password, the service's client credentials and
  every WebID.
- **Registration:** CSS registration is closed. People and reviewers are
  provisioned idempotently.
- **The lifecycle service:** a WebID and DPoP client credentials, in a secret
  volume.
- **People:** sign in to dokieli with Solid-OIDC against `assets-css`, so
  dokieli reads and writes their pods directly; CORS allows only the dokieli
  origin.
- **The lifecycle API:** takes the principal from a Solid-OIDC token, never
  from the body; roles attach to WebIDs.
- **Agents:** OpenClaw agents act under the lifecycle service's agent
  principal, with frame-scoped capability tokens, not a WebID per agent (D8).
- **Verify:**
  - a scripted login, then dokieli saves and reloads a document in a pod;
  - a forged `reviewer` field is refused.

**3. Integrity** (A3). Turns on lifecycle ↔ CSS reads and writes.
- **Status (2026-11-09): done** (localAssetStorageStack#18). Verified live in a
  real browser. The author saves a document in dokieli and the registrar
  registers it, so the service reads and pins it (ETag and SHA-256). A binding
  is made. The author edits and saves in dokieli, and the next binding is
  refused with `409 pod changed since pin`. The step-binding receipt verifies
  offline with `GET /keys` alone, and a tampered one does not. A private
  document outside `assets/` can't be pinned (409). After a restart, the event
  log reopens with its chain intact.
- **Access:** each person's `assets/` container grants the lifecycle WebID
  Read/Write (`scripts/grant-assets.js`). Workflow documents are kept there.
- **Pinning:** the service reads the pod itself and records the ETag and the
  SHA-256 of the bytes; writes carry `If-Match`.
- **History:** an append-only, fsynced event log.
- **Receipts:** Ed25519 over the RFC 8785 canonical form, with keys at `/keys`.
- **Verify:**
  - pin, edit the document in dokieli, and the next binding is refused with
    `409 pod changed since pin`;
  - receipts verify offline.

**4. The assetID frame with continuations** (localAssetStorageStack#13; A4,
A5). The core of the integration.
- **Status (2026-11-09): done** (localAssetStorageStack#19). Unit tests cover
  every continuation rule named below, plus the IFRS chain end to end, the
  `/pod` proxy and rule 7 against the instance registry.
- **Live, against real CSS documents, tokens and ETags:**
  - a frame pinned to what the pod holds, with its pointer in the pod;
  - an agent reading and writing only its own frame's document through
    `/pod`, under `If-Match`;
  - the downstream frame going STALE;
  - the preparer refused and a reviewer approving with a real Solid-OIDC
    token, and a replayed approval refused;
  - termination closing the head;
  - an abandon receipt that verifies offline.
- **Not yet wired:** rule 7 answers `unchecked` until phase 11 gives the
  service the instance registry. The IFRS keys are the case keys; the IFRS
  machines' own document templates are phase 6's source mapping.
- **The frame:**
  - `documents`: tagged URIs with pinned revisions, permissions, authorities
    and identifications;
  - `action`, `arguments`, `return`;
  - `continuations`: the frame's continuation log, with a `current` pointer.
- **Continuations live in the lifecycle service** (D10), in its append-only
  event log, with the frame's pod document holding a pointer.
- **The API:** build, read and write the frame's return; capture, park, resume,
  supersede, abandon and close a continuation. Resume checks:
  - the capability;
  - the one-shot generation;
  - the pinned hash (a mismatch takes the escape path);
  - that the named engine instance carries the template (if not, the escape
    path).
- **Abandoning** needs the case's abandon capability, never an agent's. It
  writes a receipt naming who, why and the generation, and closes the frame.
- **No step chooses its successor** beyond the PE's ISRE folding (D10). The
  chain is the template's, and what varies it is what the fold presents to
  the ISRE. The continuation records the result.
- **Agents never write a pod directly** (D5). They act through a frame-scoped
  capability token (EdDSA JWT) on the `/pod` proxy.
- **The review gate** (A4): approve requires a reviewer WebID other than the
  preparer, on the exact revision.
- **The IFRS workflow** (A5): entity, period and asset-type keys; `upstreamRefs`
  staleness propagation, which is the escape continuation.
- **Termination closes the head of the workflow** (D11). For a
  document-workflow template, the completion its clone terminates through is
  the close of the workflow head: the canonical entity/period/asset-type head
  is closed in the lifecycle service, and the frame closes with it.
- **Verify:** unit tests for every continuation rule:
  - a replayed resume;
  - a stale upstream;
  - approve by the preparer;
  - an abandon without the capability;
  - an engine instance without the template;
  - a head closed on termination.

**5. dokieli → lifecycle** (A7). Turns on dokieli ↔ lifecycle.
- **Inboxes:** each asset gets an inbox container in its pod; dokieli's
  annotations arrive there as Linked Data Notifications.
- **Subscription:** the service subscribes through CSS 7's Solid Notifications
  (WebSocket), with a startup sweep. Each annotation becomes a finding on the
  frame.
- **Reviewer decisions go through the lifecycle API** with the reviewer's
  Solid-OIDC token (D9), and resume the parked continuation. An inbox
  notification has no authenticated sender, so it never counts as an approval.
- **Verify:**
  - an annotation in dokieli appears as a finding in the frame log;
  - an API approval resumes k2 and yields k3.

**6. The lifecycle service as a PE Source.** Turns on lifecycle → engines.
- **A source mapping** for the IFRS domain's
  `reviewed-accounting-event-source-mapping`. These observations write the
  template machines' ordinary input lanes, so the templates fire and emit
  dispatch envelopes:
  - an asset entering its workflow;
  - a revision pinned;
  - a disposition;
  - a continuation resumed or gone stale.
- **The termination path:** a completion is written into the clone's own input
  quarter (`/api/integrations/completions`); for IFRS it is the head close (D11).
- **The voting PEs** write clone input quarters and compose nothing else from
  the clone band. The TypeScript PE follows (RealityEngine_Manager#324).
- **Verify:** one lifecycle event produces the same envelope on all three voting
  engines.

**7. Clone and recycle on the voting engines** (RealityEngine_CPP#191,
RealityEngine_LSP#184, RealityEngine_Scala#209). It can run in parallel from
the start.
- **Load-time recognition** and `GET /api/machines/cloneable`.
- **Clone and recycle** with block generations, lowest-free 64-cell nest blocks,
  `clone.maxActive`, and `INSTANCE_ID` in the clone id.
- **A parity spec** in `RealityEngine_Machines/tests/integration`
  (RealityEngine_CI#713).
- **Verify:** 3-of-3 in regression. The followers come on their own cadence
  (RealityEngine_Rust#71, RealityEngine_Manager#324).

**8. Agents and tools** (localOpenClawStack#91, RealityEngine_CI#714).
- **Per-clone agents:** loaded at clone and unloaded at recycle, as atomic
  `openclaw.json` edits through the FIFO queue. Each unload removes the agent's
  entry, workspace and state.
- **Agent hooks:** the prologue reads the frame; the epilogue writes `return`.
  No agent holds an approve, record or publish capability.
- **`re-mcp` tools** scoped to the frame by assetID.
- **Verify:**
  - concurrent loads and unloads leave `openclaw.json` consistent;
  - an agent can't reach a document outside its frame.

**9. Manager's instantiation component** (RealityEngine_Manager#323).
- **Hears** dispatch envelopes from the OSRE, through the PE trigger dispatch.
- **For each envelope:**
  - prologue: resume the continuation, clone, load the agents, dispatch;
  - epilogue: capture or park the next continuation, recycle with the
    generation, unload the agents.
- **Full pool:** queues FIFO.
- **Restart:** recovers from the surviving frames.
- **Routes:** serves `/api/engine/:id/clone|recycle|clones`.
- **`GUARDRAIL_CLASSES` is removed** here, once instantiation works (A6).
- **Verify:** one engine instance, one asset, the full chain with a simulated
  reviewer.

**10. Asset-workflow tracking in Grafana** (D9; RealityEngine_CI#723).
- **The lifecycle service exports:**
  - Prometheus metrics at `/metrics`: frames open; continuations by status;
    parked age; resumes, supersessions and abandons; reviews pending;
  - its event log as structured lines to Loki.
- **Manager exports** live clones and pool use per engine instance and template,
  and the queue depth.
- **A new provisioned dashboard,** `RealityEngine_CI/config/dashboards/asset-workflow.json`.
  It tracks each asset through the workflow, from frame to continuation to
  clone to review to head close, so a reviewer's wait and a stuck
  continuation are visible.
- **Verify:** the dashboard renders from a local-lane run of phase 11's chain.

**11. Suite integration and regression** (A9; RealityEngine_CI#706, #715).
- **Start and stop:** `startUniverse.sh --assets` and `stopUniverse.sh` start and
  stop this stack, and write the lifecycle and CSS addresses into
  `config/integrations.json`.
- **Release bundle:** the three images join the release images and compose.
- **Local-lane smoke test:**
  - pod provisioning;
  - a pin read back from CSS;
  - addresses stable across a restart;
  - offline receipt verification.
- **The IFRS chain on three engines, compared:**
  - prepare → review (parked, zero blocks held) → approve (approver ≠
    preparer) → record → head closed;
  - a replayed continuation refused;
  - a stale upstream escaping;
  - `maxActive + 1` concurrent actions showing the pool limit.

### Order
Phases 1 → 2 → 3 → 4 → 6 → 9 → 11 are the critical path. Phases 5, 8 and 10
run once phase 4's frame API is fixed. Phase 7 needs nothing from this stack
and runs from the start.

## What this does not change

- PIM's CSS and its PODs (D1). This stack never reads or writes them.
- The HealthKit mirror contract.
- The RE/PE APIs. A9 consumes them; it does not change them.
