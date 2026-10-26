import { describe, expect, it } from "vitest";
import { BANDS, fitDifficulty } from "./difficulty";
import type { SweBenchRaw } from "./sources";

/** SWE-bench-shaped data from a known Rasch model: harder bands, lower solve rates. */
function synthetic(): SweBenchRaw {
  const bandDifficulty = [-1.5, 0, 1.5, 2.5];
  const tasks = Array.from({ length: 200 }, (_, i) => {
    const band = i < 80 ? 0 : i < 160 ? 1 : i < 196 ? 2 : 3;
    return { id: `t${String(i).padStart(3, "0")}`, difficulty: BANDS[band]?.label as string, files: band + 1, band };
  });
  const runs = Array.from({ length: 12 }, (_, s) => -1 + (s * 2.5) / 11);
  let state = 12345;
  const uniform = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const submissions = runs.map((theta, s) => {
    const solved = tasks
      .map((task) => {
        const b = (bandDifficulty[task.band] as number) + ((task.id.charCodeAt(3) % 5) - 2) * 0.3;
        return uniform() < 1 / (1 + Math.exp(-(theta - b))) ? "1" : "0";
      })
      .join("");
    const resolved = (100 * [...solved].filter((c) => c === "1").length) / solved.length;
    return {
      board: "Verified" as const,
      name: `run ${s}`,
      agent: "mini-SWE-agent",
      models: [`model-${s}`],
      modelDisplay: `Model ${s}`,
      date: "2026-01-01",
      resolved,
      effort: null,
      solved,
    };
  });
  // A run whose published details disagree with its rate is ignored.
  submissions.push({ ...(submissions[0] as (typeof submissions)[number]), name: "broken", resolved: 90 });
  return { fetchedAt: "x", tasks: tasks.map(({ band: _band, ...task }) => task), submissions };
}

describe("fitDifficulty", () => {
  it("orders the bands by difficulty and links abilities to the Rasch scale", () => {
    const fit = fitDifficulty(synthetic());
    const means = fit.bands.map((band) => band.mean);
    expect(means[0]).toBeLessThan(means[1] as number);
    expect(means[1]).toBeLessThan(means[2] as number);
    expect(means[2]).toBeLessThan(means[3] as number);
    expect(fit.bands.map((band) => band.tasks)).toEqual([80, 80, 36, 4]);
    expect(fit.link.runs).toBe(12);
    expect(fit.link.slope).toBeGreaterThan(0.5);
    expect(fit.link.residualSd).toBeLessThan(0.5);
  });
});
