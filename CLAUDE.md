# localAssetStorageStack Guidance

Last reviewed: 2026-11-04

See `/Users/johnt/workspace/GitHub/CLAUDE.md` for the integrated application
map. Update both this file and the root map when the stack's services, its
addresses, the lifecycle API or its integration with the engines change.

## Role

Local dokieli asset storage for the RealityEngine suite, in the release from
`release-v0.0.2` (RealityEngine_CI#706). Three services on the external
`reality-engine` Docker network:

- `css`: a Solid Community Server holding the document pods. **It is one of
  several CSS instances in the suite, each at its own address.** It is not
  PIM's, and the two are never merged. Only the image version is shared with
  PIM's (RealityEngine_CI#707).
- `dokieli`: the authoring and annotation UI. It is built from a pinned dokieli
  commit with Yarn 4 and dokieli's own lockfile (`dokieli/Dockerfile`).
- `lifecycle`: the document lifecycle API (`lifecycle/`). It is the **store and
  gatekeeper** for assets (decision D6):
  - it holds pinned revisions, history and receipts;
  - it owns the asset pointer that agents use;
  - pod writes go only through it (D5).

  It does not instantiate workflow machines or decide transitions. A separate
  instantiation component does that, driven through the ISRE and OSRE
  (localAssetStorageStack#8).

## Codebase map

- `docker-compose.yml`: the three services and their volumes.
- `scripts/up.js`: starts the stack on free loopback ports and writes
  `runtime/registry.json`. That file is the stack's own service registry, not
  the instance registry; it is gitignored runtime state.
- `lifecycle/src/app.js`: routes, store and receipts.
- `lifecycle/test/`: `node --test`.
- `css/config.json`: CSS configuration.
- `ROADMAP.md`: the plan that answers the gaps review
  (`docs/localAssetStorageStack Gaps.pdf`), milestones A0–A9 and decisions
  D1–D6. Read it before changing the lifecycle model, identity, storage or
  addressing.

## Key commands

```bash
nvm use                      # Node from .nvmrc, never the terminal default
cd lifecycle && npm test     # lifecycle tests
cp .env.example .env         # then fill in tokens (>= 16 chars) and RECEIPT_SECRET
node scripts/up.js           # start; replaces `docker compose up -d --build`
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

## Standing rules — authoritative in `RealityEngine_CI/docs/ENGINEERING_CONTRACT.md`

The contract's wording governs. The rules in short:

- Qualify every "registry".
- Regenerate a stale registry; don't fail it.
- Verify a merge beyond the hosted checks.
- RealityEngine_CI is the authority.
- Name these files `CLAUDE.md`, uppercase.
- Never commit to main: branch from `origin/main`, PR, verify, squash-merge,
  clean up.
- Use `/opt/homebrew/bin/bash`, not zsh.
