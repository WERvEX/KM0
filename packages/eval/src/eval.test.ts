import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DiscussionLlm } from "@km0/core";
import { describe, expect, it } from "vitest";
import { loadCases } from "./cases";
import { Cassette, MissingRecording, recording, replaying } from "./cassette";
import { keeps, report, runEval } from "./run";

const set = loadCases(join(import.meta.dirname, "../cases"));

/** Answers as a perfect model would: every stated criterion carried over, every verdict matching the hidden tests. */
function perfect(): DiscussionLlm {
  return {
    async structured(_role, call) {
      if (call.purpose === "breakdown") {
        const item = set.breakdown.find((candidate) => call.prompt.includes(candidate.description));
        const output = {
          tasks: [
            {
              title: "t",
              goal: "g",
              acceptance: item?.criteria.map((criterion) => criterion.match[0]?.join(" ") ?? "") ?? [],
              files: [],
              depends_on: [],
              decision_keys: [],
              sections: [],
              test_command: null,
              features: {
                scope: "single_file",
                ambiguity: "low",
                reasoning: "follow",
                context: "small",
                has_tests: true,
                risks: [],
                kind: "code",
              },
            },
          ],
        };
        return call.schema.parse(output);
      }
      // Cases come in pairs with the same task; the change tells them apart.
      const item = set.judge.find(
        (candidate) =>
          candidate.task.acceptance.every((line) => call.prompt.includes(line)) &&
          (candidate.diff === null || call.prompt.includes(candidate.diff.trim())),
      );
      return call.schema.parse({ accepted: item?.hidden.passed ?? false, reason: "matches the criteria" });
    },
  };
}

describe("eval set", () => {
  it("loads, and every criterion is stated in its own request, decisions or documents", () => {
    expect(set.breakdown.length).toBeGreaterThanOrEqual(6);
    expect(set.judge.length).toBeGreaterThanOrEqual(10);
    for (const item of set.breakdown) {
      const stated = [
        item.description,
        ...item.decisions.map((decision) => decision.value.text),
        ...item.documents.flatMap((doc) => doc.sections.map((section) => section.body)),
      ].join(" ");
      for (const criterion of item.criteria)
        expect(keeps([stated], criterion.match), `${item.id}/${criterion.id}`).toBe(true);
    }
    // Both outcomes are represented, so agreement is not won by always saying yes or no.
    expect(set.judge.some((item) => item.hidden.passed)).toBe(true);
    expect(set.judge.some((item) => !item.hidden.passed)).toBe(true);
  });

  it("matches criteria by words, ignoring case and full-width forms", () => {
    expect(keeps(["统计前应当去掉 <THINK> 块"], [["think"]])).toBe(true);
    expect(keeps(["响应头里有 Retry-After"], [["retry-after"]])).toBe(true);
    expect(keeps(["表头：订单号,金额"], [["订单号", "状态"]])).toBe(false);
    // The words must be in one criterion, not spread over several.
    expect(keeps(["含有订单号", "含有状态"], [["订单号", "状态"]])).toBe(false);
  });
});

describe("scoring", () => {
  it("scores a perfect model at 100%, and counts false rejects and accepts", async () => {
    const result = await runEval(set, perfect());
    expect(result.metrics).toMatchObject({ retention: 1, agreement: 1, falseRejects: 0, falseAccepts: 0, errors: 0 });
    expect(result.metrics.casesComplete).toBe(set.breakdown.length);

    const yes: DiscussionLlm = {
      async structured(role, call) {
        if (call.purpose === "acceptance") return call.schema.parse({ accepted: true, reason: "ok" });
        return perfect().structured(role, call);
      },
    };
    const lenient = await runEval(set, yes);
    expect(lenient.metrics.falseAccepts).toBe(set.judge.filter((item) => !item.hidden.passed).length);
    expect(lenient.metrics.agreement).toBeLessThan(1);
    expect(report(lenient, "always yes")).toMatch(/误判通过 \d+/);
  });

  it("names the criteria a breakdown lost", async () => {
    const forgetful: DiscussionLlm = {
      async structured(role, call) {
        const answer = (await perfect().structured(role, call)) as { tasks?: { acceptance: string[] }[] };
        if (call.purpose === "breakdown" && answer.tasks?.[0])
          answer.tasks[0].acceptance = answer.tasks[0].acceptance.slice(1);
        return answer as never;
      },
    };
    const result = await runEval(set, forgetful);
    expect(result.metrics.retention).toBeLessThan(1);
    expect(result.breakdown.every((item) => item.lost.length === 1)).toBe(true);
    expect(report(result, "forgetful")).toContain("word_count");
  });
});

describe("recordings", () => {
  it("records each answer once and replays it without the model, failing on a changed prompt", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "km0-eval-")), "model.jsonl");
    let calls = 0;
    const live: DiscussionLlm = {
      async structured(role, call) {
        calls += 1;
        return perfect().structured(role, call);
      },
    };
    let current = "";
    const recorded = await runEval(
      set,
      recording(live, new Cassette(file), () => current),
      (id) => {
        current = id;
      },
    );
    expect(calls).toBe(set.breakdown.length + set.judge.length);

    const cassette = new Cassette(file);
    expect(cassette.size).toBe(calls);
    const replayed = await runEval(
      set,
      replaying(cassette, () => current),
      (id) => {
        current = id;
      },
    );
    expect(replayed.metrics).toEqual(recorded.metrics);

    const changed = {
      ...set,
      judge: set.judge.map((item) => ({ ...item, task: { ...item.task, goal: `${item.task.goal}!` } })),
    };
    const stale = await runEval(
      changed,
      replaying(cassette, () => current),
      (id) => {
        current = id;
      },
    );
    expect(stale.judge.every((item) => item.error?.includes("record again"))).toBe(true);
    expect(new MissingRecording("x", "acceptance").message).toMatch(/pnpm --filter @km0\/eval record/);
  });
});
