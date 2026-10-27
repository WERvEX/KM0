# @km0/eval

KM0's offline eval set. It checks the two places where a model's mistake costs the most:

- **Breakdown keeps every stated criterion.** `cases/breakdown/*.json` holds requests (with decisions and
  documents) and the acceptance criteria they state. The planner's tasks must carry each one; a criterion
  counts as kept when one task criterion contains every word of one of its `match` alternatives.
- **Acceptance agrees with hidden tests.** `cases/judge/*.json` holds a task, the change an agent made and
  what hidden tests said about it. KM0's verdict should match. False rejects (the hidden tests passed, KM0
  said no) waste a stronger model's run; false accepts let a broken change through.

The cases reproduce failures seen in 0.1's calibration runs: a criterion left only in a decision
(`strip-think`), tests already written by the upstream task (`tests-already-upstream`, behind 5 of 6 false
rejects), and gaps the visible tests do not catch (missing BOM, Retry-After, a blocked horse leg, an
off-by-one).

## Running

```bash
pnpm --filter @km0/eval record [label]   # asks a model, records every answer to recordings/<label>.jsonl
pnpm --filter @km0/eval replay [label]   # recorded answers only, no API key; writes reports/<label>.md
pnpm --filter @km0/eval smoke            # the simulated model, to check the harness itself
```

Recording reads `KM0_EVAL_API_KEY` (or `ANTHROPIC_API_KEY`), `KM0_EVAL_PROVIDER` (`anthropic` or
`openai`), `KM0_EVAL_BASE_URL` and `KM0_EVAL_MODEL` (default `claude-sonnet-5-5`); the label defaults to the
model. With `KM0_EVAL_BRIDGE=<folder>` nothing is sent anywhere: each request is written to
`<folder>/NNN.request.md` and the run waits for someone else (a person, another model session that reads only
that request) to write `NNN.response.md`.

Answers are keyed by the prompt, so after a prompt change replay reports the cases to record again. That is why
the eval is run by hand and not in CI; `pnpm test` here only checks the harness and the cases themselves.
Commit the recording and the report together, so a prompt change shows its effect in review.
