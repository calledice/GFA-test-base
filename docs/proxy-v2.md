# GFA inspection proxy v2: frozen baseline

## Question and scope

The ranking asks which GFA atomic event is worth opening first in a failed-task investigation. It does not predict the probability that the event caused the task failure. Scores are discrete order keys within one trajectory; equal scores are broken by ascending event step. The rule reads each event's structured type, action and execution fields. It does not read the adjudicated origin/decisive-step labels, official outcome, future events or screenshots.

GFA atomic events do not carry DSH's trusted `structured-shell-exit-v1` observation. Native `inspection-priority-v3` therefore abstains on these records; this GFA score must not be reported as native DSH validity.

## Frozen score table

| Event evidence | Score |
| --- | ---: |
| Explicit runtime, capture or dispatch error | 60 |
| `DONE` or `stop` completion claim | 42 |
| Concrete model action proposal or reasoning decision | 38 |
| Other model response | 36 |
| Planning, task understanding or reflection | 34 |
| Screenshot-only or wait-only model action | 30 |
| Ordinary tool call | 26 |
| Communication or termination | 24 |
| Observation | 22 |
| Wait-only tool call | 20 |

The executable rule is `proxyScore` in `scripts/benchmark-gfa-proxy.mjs`. A completion claim is a place to verify the final artifact, not evidence that the task succeeded. A runtime error can be a recovered or irrelevant symptom.

## Observed local results

The earlier offline comparison used 139 completed, officially failed, annotated GFA records. Of these, 104 task groups were used for rule development and 35 were held out for a first frozen comparison. On the 35 held-out records, the previous event-type rule versus v2 placed an annotated origin in Top 5 for 20 versus 23 cases, and a decisive event in Top 5 for 13 versus 20. These are **annotation-position coverage** counts, not investigation-cost or causal-chain results. The held-out sample is small, and its labels were created for attribution rather than inspection value.

A later incremental three-case pilot used the same investigator model for ranked, chronological and self-directed entry. The first **model-proposed** actionable clue appeared after 1/1/3 opened steps with the proxy, 1/2/2 chronologically, and 2/2/1 with self-direction. The proxy investigator proposed a chain in 1 of 3 cases; the chronological investigator in 0; self-directed in 1. None of these A/C claims has been independently adjudicated, so the pilot does not establish an effectiveness gain. The aggregate counts and costs are in `results/2026-10-19_05_gfa_inspection_journey_three_case_summary.json`.

An earlier six-case budgeted position-localization replay fell back to full context in every case. Position accuracy from that replay cannot measure the number of steps actually inspected. This motivated the incremental `open_step` protocol.

## Baseline limitations

The investigator is free to ignore recommendations. The runner logs actual `open_step` calls and charges model calls, tokens, image transmissions and time. A model's self-reported `check_path` is not used as observed inspection behavior. Full-trajectory one-call arms cannot have a measured step-opening cost.

At the source snapshot, only 10 new task groups passed machine eligibility after excluding cases used in earlier rule selection. They still required independent outcome confirmation and A/C adjudication. The old cases were used to develop the instrumentation and cannot serve as untouched confirmatory samples.
