# Investigation Prioritization adjudication format

The new evaluator consumes the journey runner's JSON output and a separate JSONL file. The JSONL file is authored by independent reviewers after arm-blinded review. Do not populate it from the model's self-assessment or old origin/decisive-step labels.

One case row is required per evaluated case:

```json
{"kind":"case","caseId":"synthetic-1","class":"in_trace","actionableEligible":true,"chainEligible":true,"goldChains":[{"id":"valid-chain-1","edgeIds":["e_requirement_to_action","e_action_to_output","e_output_to_failure"]}]}
```

The edge IDs refer to a frozen, evidence-cited directed reference graph held in the private adjudication packet. Include every accepted alternative chain in `goldChains`. Set `chainEligible: false` and `goldChains: []` when no trajectory-internal chain can be established. An external-only case may still have an actionable clue if reviewers can identify a falsifiable next check.

One checkpoint row is required for every checkpoint containing an `actionable` or `chain` candidate:

```json
{"kind":"checkpoint","caseId":"synthetic-1","mode":"ranked","checkpointIndex":0,"hypothesisValid":true,"canonicalHypothesisId":"H1","supportedEdgeIds":["e_requirement_to_action"],"unsupportedEdgeCount":0,"completeChainValid":false}
```

Use `hypothesisValid: false` and `canonicalHypothesisId: null` for an invalid or absent hypothesis. Assign one canonical ID to paraphrases of the same testable claim; distinct testable claims get distinct IDs. `supportedEdgeIds` may contain only edges in that case's accepted reference chains and only when the checkpoint made a chain claim supported by already disclosed evidence. `unsupportedEdgeCount` counts claimed causal links that the evidence does not support. Mark `completeChainValid` only when the checkpoint establishes one accepted reference chain, including recovery and alternatives.

The evaluator verifies types, uniqueness, case/arm/checkpoint references, edge membership and that a complete-chain verdict has cumulatively covered a reference chain. It cannot verify whether a human reviewer truly read the source, whether an edge is causally correct, or whether a cited screenshot was legible. Those are review responsibilities.

```sh
node scripts/evaluate-investigation-prioritization.mjs --results results/raw/run.json --labels results/raw/adjudication.jsonl --out results/raw/investigation-evaluation.json
```

Any missing case or required checkpoint judgment produces `unadjudicated` for that case-arm. Numeric summaries include only fully adjudicated eligible case-arms and display their denominators; absent chain eligibility produces `null` coverage, never zero.
