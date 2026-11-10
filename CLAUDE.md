# localAssetStorageStack Guidance

Last reviewed: 2026-11-09

See `/Users/johnt/workspace/GitHub/CLAUDE.md` for the integrated application
map. Update both this file and the root map when the stack's services, its
addresses, the lifecycle API or its integration with the engines change.

## Role

Local dokieli asset storage for the RealityEngine suite, in the release from
`release-v0.0.2` (RealityEngine_CI#706). Three services on the external
`reality-engine` Docker network:

Every link is **TLS 1.3** (RealityEngine_CI#668, ROADMAP phase 1): certificates from RealityEngine_CI `scripts/lib/re_pki.py`, no plaintext listener, `https` pod URLs only. lifecycle → `assets-css` has no mTLS because CSS can't verify client certificates (an owner-accepted deficiency).

**Identity** (ROADMAP phase 2): `assets-css` registration is closed, and the only accounts are seeded by `up.js` (`scripts/accounts.js`):
- the lifecycle service's own WebID;
- the people in `ASSETS_PEOPLE`.

Secrets live in `.secrets/` (gitignored, 0600), never under `runtime/`, which the lifecycle service mounts. The lifecycle API takes:
- people from Solid-OIDC DPoP tokens issued by `assets-css`, with roles from `runtime/roles.json`;
- services by tokens of at least 32 bytes;
- agents by EdDSA capability tokens, one per frame step.

`admin` implies no other role.

- `assets-css` at `https://assets-css.localhost:13443/` (fixed, D7): a Solid Community Server holding the document pods. **It is one of
  several CSS instances in the suite, each at its own address.** It is not
  PIM's, and the two are never merged. Only the image version is shared with
  PIM's (RealityEngine_CI#707).
- `assets-dokieli` at `https://assets-dokieli.localhost:13444/` (fixed, D7): the authoring and annotation UI. It is built from a pinned dokieli
  commit with Yarn 4 and dokieli's own lockfile (`dokieli/Dockerfile`).
- `lifecycle`: the document lifecycle API (`lifecycle/`). It is the **store and
  gatekeeper** for assets (decision D6):
  - it holds pinned revisions, history and receipts;
  - it owns the asset pointer that agents use;
  - pod writes go only through it (D5).

  It does not instantiate workflow machines or decide transitions.
  RealityEngine_Manager's instantiation component does that, driven through
  the ISRE and OSRE (localAssetStorageStack#8). Workflow rules live in the
  corpus (D4).

## Codebase map

- `docker-compose.yml`: the three services and their volumes.
- `scripts/up.js`: issues the certificates (needs RealityEngine_CI beside this
  repo, or `RE_PKI`), links them under `runtime/pki/`, refuses a taken fixed
  port, starts the stack and writes `runtime/registry.json`: the stack's own
  service file, not the instance registry; gitignored runtime state.
- `lifecycle/src/app.js`: routes, store and receipts.
- `lifecycle/src/identity.js`: the Solid-OIDC/DPoP verifier, the role list, service tokens, capability tokens and the service's own CSS identity. `lifecycle/src/jose.js`: JWS, thumbprints and DPoP proofs on `node:crypto` (no dependencies).
- `lifecycle/src/integrity.js`: RFC 8785 canonical JSON, Ed25519 receipts, the hash-chained fsynced event log and the pod client (ETag, SHA-256, If-Match). Integrity (ROADMAP phase 3): the service pins what the pod holds and refuses a frame, a resume or a write when it has changed (`409 pod changed since pin`, or the escape path at resume).
- `lifecycle/src/lanes.js`: the lifecycle as a PE Source (ROADMAP phase 6). A frame's lanes are the reserved cells 2–7 of the clone running its step; they're allocated when the clone is made and freed at recycle, through one sensor source per engine and block on that engine's PE.
- `lifecycle/src/frames.js`: the assetID frame, its continuation log and the `/pod` proxy (ROADMAP phase 4; RealityEngine_CI `docs/CONTINUATIONS_APPROVAL_CHAIN.md` is authoritative). `lifecycle/src/engines.js`: the engine link through the instance registry (`RE_REGISTRY_URL`, lane mTLS): continuation rule 7, a template's reserved cells, and PE sources.
- `scripts/grant-assets.js`: gives the lifecycle WebID Read/Write on each person's `assets/` container (run by `up.js`). `scripts/verify-receipt.js`: offline receipt verification.
- `scripts/smoke.js`, `scripts/chain-regression.js`: checks against a running universe (ROADMAP phase 11): the local-lane smoke test, and the IFRS chain on cpp, lsp and scala compared 3-of-3. RealityEngine_CI's regression `asset-workflow` stage runs both; `scripts/lib/universe.js` is what they share (env in its header).
- `scripts/accounts.js`: the seeded accounts, the CSS seed and the role list (tests: `scripts/accounts.test.js`).
- `lifecycle/test/`: `node --test`.
- `css/config.json`: CSS configuration (file storage, HTTPS server factory).
- `ROADMAP.md`: the plan that answers the gaps review
  (`docs/localAssetStorageStack Gaps.pdf`), milestones A0–A9 and decisions
  D1–D6. Read it before changing the lifecycle model, identity, storage or
  addressing.

## Key commands

```bash
nvm use                      # Node from .nvmrc, never the terminal default
cd lifecycle && npm test     # lifecycle tests
node --test scripts/*.test.js  # account provisioning tests
cp .env.example .env         # service tokens (>= 32 bytes), optional ASSETS_PEOPLE
node scripts/up.js           # start; replaces `docker compose up -d --build`
node --dns-result-order=ipv4first scripts/smoke.js   # against a running stack (README)
```

## Pins

- Node is the suite's one minor, in `.nvmrc`, the `node:<minor>-alpine` images
  and the strict `engines` range. It is moved only by
  `RealityEngine_CI/scripts/advance-node.sh`.
- dokieli is pinned by commit, Corepack by version, and nginx by digest, in
  `dokieli/Dockerfile`. Move a pin deliberately and say why in the commit.
- The CI runner is `ubuntu-24.04`, upgraded deliberately.

## CI

`.github/workflows/ci.yml` is minimal on purpose. Verification belongs to
RealityEngine_CI, whose regression harness pins this repo, runs the lifecycle
tests and builds its images on the local lane. The contract is
`RealityEngine_CI/docs/ENGINEERING_CONTRACT.md`. Builds are controlled through
RealityEngine_CI (`docs/BUILD_CONTROL_CONTRACT.md`).

## Standing rules

The standing rules are in
`../RealityEngine_CI/docs/ENGINEERING_CONTRACT.md`, which is
authoritative. They are not listed or summarised here, so this file never
falls behind the contract. Read it before changing anything here.
