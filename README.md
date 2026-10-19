# GFA Test Base

This repository contains a standalone snapshot of the GFA inspection proxy experiments. Its first branch, `gfa_inspection_proxy`, preserves the `gfa_inspection_proxy_v2` ranking rule, replay tools, tests, and aggregate pilot outputs. The GFA atomic-event score is a within-trajectory inspection order, **not** a failure probability, a causal attribution label, or the native DeepSeek Harness score.

## What is here

- [Scoring rule and existing evidence](docs/proxy-v2.md)
- [Replay and data contract](docs/reproduction.md)
- `scripts/`: retrospective scoring, multimodal and three-arm replays, incremental evidence disclosure, and evaluation
- `test/`: synthetic unit and integration fixtures
- `results/`: aggregate, unadjudicated pilot summaries

The code was copied from the local `dsh-step-risk` research working tree on 2026-10-19. The `src/` modules are the exact local dependency chain needed to check that GFA events abstain under the native DSH rule; GFA's own ranking is in `scripts/benchmark-gfa-proxy.mjs`. The source working tree had uncommitted changes, so this Git commit is the immutable reference for this snapshot.

## Run checks

Use Node.js 22.19+ or 24+:

```sh
npm test
```

Model replays additionally require a compatible Responses API endpoint and an `OPENAI_API_KEY` environment variable. Image normalization requires Python with Pillow. Supply your own authorized GFA records endpoint and a manifest whose source hashes match that endpoint; see [reproduction](docs/reproduction.md).

## Publication boundary

Only code, synthetic fixtures, study descriptions, and aggregate summaries are committed. Raw GFA responses, screenshots, full model transcripts, credentials, and the internal source endpoint are not included. The published summaries are descriptive pilot records: no independent A/C adjudication or confirmatory holdout result is available.
