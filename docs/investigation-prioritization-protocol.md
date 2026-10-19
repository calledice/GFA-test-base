# Investigation Prioritization: prospective proxy experiment

Status: **design and evaluation instrument, not an effectiveness result**. Freeze this protocol, the scoring implementation and the model configuration before selecting new confirmatory task groups. The `gfa_inspection_proxy_v2` baseline remains unchanged on this branch.

## Research question

For a verified failed agent task, does a recommendation of where to inspect next reduce the investigator's *observed* effort to form a testable hypothesis and establish a supported causal chain? The intervention is a displayed opening recommendation. The outcome is investigator behavior under incremental evidence disclosure. A high-priority event may be a symptom or useful turning point; it need not be the earliest root cause. The proposed measures are First-Hypothesis-Cost (FHC), Hypothesis-Generation-Rate (HGR), and Causal-Chain-Coverage (CCC).

The primary contrast is **proxy-ranked versus chronological recommendation** with the same LLM investigator, task card, evidence interface and budget. Self-directed selection is a practice comparator. A FALAT-derived entry policy is a secondary comparator only if its candidate output can be adapted to this interface with its full preparation cost and privileged full-trajectory access explicitly reported. FALAT itself reasons over typed dependencies and measures decisive-step attribution; this experiment must not portray it as merely returning an unexplained step.

## Units, cohort and preregistration

- Unit of inference: independent task group, not model call, checkpoint or repeated run. Group reruns and trajectories sharing a benchmark task, source artifact or screenshot before splitting.
- Include an official completed failure only after an independent reviewer verifies the final unmet task condition from the task specification and artifact. Preserve task, event and image hashes. Separate `in_trace`, `external_only`, `trace_missing` and `unresolved`; do not fabricate an internal chain for a failure whose evidence is outside the trace.
- Exclude every case used to inspect, tune or test the scoring rule, prompts, annotation rubric or runner from confirmatory estimates. The 2026-10-19 three-case journey pilot consumed three of the ten then-new candidate groups; at most seven of that candidate pool remain untouched, and even those still need independent outcome and chain review. Additional independent groups are required.
- Use the remaining eligible cases for feasibility and variance estimation. Specify a target effect and sample size from a separate pilot before a confirmatory run. Fewer than 20 independent, fully reviewed groups yields descriptive paired case results only; 20 is a reporting floor, not proof of statistical power.
- Freeze task cards, case list, score implementation, model and reasoning settings, prompt, budgets, retry rules, hypotheses and analysis code. Record exclusions before opening intervention outcomes.

## What the investigator sees

Each arm receives the same neutral task card: original objective, independently verified unmet condition phrased without causal clues, public acceptance criteria, and a metadata-only event index. It does not receive the annotation, gold graph, official failure explanation or any event body before opening that event. If the acceptance criterion itself gives away the causal step, revise the card uniformly or exclude the case.

The `ranked` arm sees up to five unvisited proxy-ranked event numbers, recomputed after each opening. The `chronological` arm sees the next five unvisited event numbers. The `self_directed` arm sees no recommendation. A recommendation is never automatically opened. The server logs the actual `open_step` sequence, recommendation uptake, each `read_chunk`, full disclosed field/image hashes, model tokens and time. `check_path` prose is not treated as a reading log.

After every newly disclosed piece, the investigator records either no hypothesis or a candidate with (1) a concrete discrepancy and evidence references, (2) a falsifiable claim, (3) a specific next inspection, and (4) observations that would support and refute it. It may also record a causal-chain candidate with references. The investigator can abstain. Cap every run at 30 distinct opened steps, 600 seconds and 120 model calls; stop at the first reached limit. Any model API or tool failure follows a frozen whole-arm retry rule and is reported separately.

## Independent reference and blinded judgment

Two experts inspect the complete task, artifact, trace and verified images independently before seeing any arm output. They classify whether an actionable clue and causal chain are observable inside the trace. For each acceptable chain they record evidence-backed directed edges: requirement/expected state, deviating decision or external fault, propagation, recovery or absence of recovery, and final unmet condition. Multiple equivalent or interacting chains are allowed. They reconcile disagreements through a third reviewer. Each edge has a stable opaque ID; the investigator never sees these IDs.

Checkpoint judges receive randomized, arm-blinded snapshots containing only evidence disclosed *by that checkpoint*. They judge:

1. Whether the candidate hypothesis is specific, testable, narrows at least one plausible alternative and is supported by cited disclosed evidence. They assign the same canonical hypothesis ID to semantically equivalent valid claims. An unsupported but plausible idea is not a valid observation.
2. Which reference-graph edges are supported by the chain claim's cited disclosed evidence, how many asserted edges are unsupported, and whether a complete causal chain is established, including relevant recovery and alternative explanations.
3. Whether a newly proposed alternative chain is valid. If so, add it by blinded consensus, then rescore **all** arms with the same expanded reference set.

A claim cannot inherit evidence opened later. Adjudicators may inspect full source material to verify a cited fact, but that material cannot be credited as evidence available to the investigator at an earlier checkpoint. Record reviewer disagreement and reasons before reconciliation.

## Outcomes and exact definitions

Let `k` count distinct `open_step` events, not model requests or chunks. All prefixes use actual server logs. Missing adjudications make the case-arm `unadjudicated`; they are never converted to failures or successes.

| Outcome | Definition | Role |
| --- | --- | --- |
| FHC | First distinct-step count at a checkpoint with an independently valid, new, testable hypothesis. Report reach by 1/3/5/10/30 steps, a budget-penalized cost of 31 for no reach within 30, and time to that checkpoint. | Primary first-lead outcome |
| Complete-chain cost | First distinct-step count and elapsed time at an independently valid complete chain; report reach by 30 steps/600 seconds and budget-penalized cost. | Co-primary guard against shallow leads |
| HGR@5, HGR@10 | Number of distinct valid canonical hypothesis IDs available by the `k`th opened step divided by `k`. A run ending early keeps its accumulated numerator with the same denominator. Also report the count of invalid and repeated proposals. | Diagnostic yield |
| CCC@5, CCC@10, CCC@end | For each accepted reference chain, fraction of its directed edge IDs supported by disclosed evidence and a chain claim by that prefix; take the maximum across accepted chains. Report unsupported asserted edges and complete-chain validity alongside it. No observable reference chain means `not applicable`, not zero. | Diagnostic coverage |
| Total cost | Post-fetch ranking preparation plus investigation calls: elapsed time, tokens, distinct/repeated steps, image bytes and transmissions. The current runner records common source fetch separately from arm time. | Operational cost |

CCC coverage alone cannot establish causality: listing every possible edge could score well. Therefore complete-chain validity and unsupported-edge counts always accompany CCC. HGR cannot be maximized by producing many paraphrases because only independently valid canonical IDs count. FHC cannot be called a chain result.

## Human comparison and LLM investigator validity

Draw 50 independent, stratified cases *only when that many qualified cases exist* for a human-comparison study. Give at least two expert investigators the same task card, interface and budget. Compare their observed FHC, chain-cost and paths with the LLM arms. Separately, have two blinded human judges score a fixed, randomized set of candidate hypotheses and graph-edge claims; measure human–human and LLM–human agreement on **validity decisions**, with uncertainty intervals, class-specific sensitivity and false-positive rate. Free-text hypothesis strings are matched through canonical IDs rather than literal equality.

An observed agreement of 35/50 is a 70% point estimate with a wide interval; it is not automatic validation. Predeclare a minimum acceptable agreement and false-positive rate against human–human reliability. If agreement is poor, improve the rubric or use human adjudication for the main experiment. A position-coverage proxy cannot silently replace the stated human-effort outcome.

## Analysis and decision rule

Use paired task-group differences for `ranked − chronological`; rotate arm run order by group and use fresh isolated model sessions. Report all groups' reach, budget-penalized steps and time, actual observed stop time, and case-level differences, including abstentions and `external_only` cases in the coverage accounting. Assigning 31 steps or 600 seconds to an unreached case is an explicit penalty, not a survival-analysis estimate. Do not average time only among successful runs. Use task-group bootstrap intervals only when sample size is adequate and identify all exploratory strata (framework, GUI/non-GUI, silent deviation, explicit error, recovery, external-only, trajectory length). Repeated model runs, if used, remain nested within task groups.

Claim a beneficial investigation policy only when the proxy reduces the first valid lead's cost **and** the budgeted complete-chain result is not materially worse under a predeclared margin. Report mixed results as mixed. The experiment cannot guarantee the anticipated ranking benefit. The existing three-case pilot is unadjudicated and is instrumentation evidence only.

## Implementation boundary

`scripts/evaluate-investigation-prioritization.mjs` computes these metrics from the existing journey log plus independently authored JSONL case/checkpoint labels. It rejects incomplete or contradictory labels. The evaluator does not create truth labels or infer a graph from model text. The current runner emits one actionable candidate and one chain candidate per checkpoint; this is sufficient to measure one new hypothesis after each check, but bounds HGR at one candidate per checkpoint. A future multi-candidate interface would require a separately versioned prompt and rerun of every arm.
