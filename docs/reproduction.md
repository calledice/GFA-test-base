# Replay and data contract

The scripts expect GFA `/records`, `/record?id=...`, and `/image` endpoints. The repository intentionally does not contain a live endpoint URL or raw records. Provide an endpoint that you are permitted to access. The source and atomic-event SHA-256 values in a manifest must match the returned records.

## Offline scoring

```sh
node scripts/evaluate-gfa-proxy.mjs --records records.json --out results/raw/offline.json
```

This report evaluates coverage of existing attribution positions. It is a diagnostic proxy, not an inspection-value ground truth. `results/raw/` is ignored by Git.

## Incremental evidence-disclosure pilot

Create a manifest from the records you can access, or select a cohort:

```sh
node scripts/select-gfa-inspection-cohort.mjs --site "$GFA_SITE" --exclude previous-cases.json --out results/raw/candidates.json --count 20
```

The manifest stores the site URL and should remain in `results/raw/` when the endpoint is non-public. Run a transport-only dry run first:

```sh
node scripts/run-gfa-inspection-journey.mjs --manifest results/raw/candidates.json --out results/raw/dry-run.json --site "$GFA_SITE" --dry-run
```

For a real model run, set `OPENAI_API_KEY` in the environment and add `--api-url "$RESPONSES_API_URL" --model "$MODEL"`. The three arms are `ranked`, `chronological`, and `self_directed`; each receives the same task card, index, and step evidence. The ranked arm only gets recommended step numbers. `open_step` reveals all short fields and verified images for that step; long fields are available through `read_chunk`. The runner logs actual openings and checkpoints.

Evaluate the output with an **independently produced** JSONL adjudication file:

```sh
node scripts/evaluate-gfa-inspection-journey.mjs --results results/raw/run.json --labels results/raw/adjudication.jsonl --out results/raw/evaluation.json
```

Without adjudication, the evaluator reports `unadjudicated`. A case record must specify `kind: "case"`, `caseId`, `class` (`in_trace`, `external_only`, `trace_missing`, or `unresolved`) and A/C eligibility. A checkpoint record specifies `kind: "checkpoint"`, `caseId`, `mode`, `checkpointIndex`, `actionableValid`, and `chainValid`. Human reviewers must see the evidence available *at that checkpoint*, not later evidence or the arm name.

## Scope of the published outputs

The committed JSON files are aggregate summaries with no case transcripts. They retain `unadjudicated` status. No score improvement or causal-chain benefit can be inferred from them until blinded labels and an independent evaluation cohort exist.
