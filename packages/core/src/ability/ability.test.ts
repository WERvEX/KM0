import type { DifficultyBand, Estimate } from "@km0/shared";
import { describe, expect, it } from "vitest";
import {
  bandForScore,
  normalQuantile,
  type Outcome,
  passProbability,
  passProbabilityAt,
  sigmoid,
  updateAbility,
} from "./ability";

const exact = (mean: number): Estimate => ({ mean, sd: 0 });

const bands: DifficultyBand[] = [
  { id: "lt15m", maxScore: 2, difficulty: { mean: -1.2, sd: 2.2 }, tasks: 194 },
  { id: "15m-1h", maxScore: 5, difficulty: { mean: 0.3, sd: 2.6 }, tasks: 261 },
  { id: "1h-4h", maxScore: 7, difficulty: { mean: 2.8, sd: 2.4 }, tasks: 42 },
  { id: "gt4h", maxScore: null, difficulty: { mean: 3.9, sd: 2.5 }, tasks: 3 },
];

/** A small deterministic generator, so the simulations are the same on every run. */
function generator(seed: number) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state + 0.5) / 2 ** 32;
  };
  const normal = () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
  return { uniform, normal };
}

describe("passProbability", () => {
  it("is the logistic curve when everything is known", () => {
    expect(passProbability({ ability: exact(1), offset: exact(0.5), difficulty: exact(0) })).toBeCloseTo(sigmoid(1.5));
  });

  it("falls as tasks get harder and is pulled towards one half by uncertainty", () => {
    const at = (difficulty: number, sd = 0) =>
      passProbability({ ability: { mean: 2, sd }, offset: exact(0), difficulty: exact(difficulty) });
    expect(at(0)).toBeGreaterThan(at(1));
    expect(at(1)).toBeGreaterThan(at(3));
    expect(at(0, 2)).toBeLessThan(at(0));
    expect(at(0, 2)).toBeGreaterThan(0.5);
  });

  it("matches a Monte Carlo average of the logistic curve", () => {
    const chance = {
      ability: { mean: 1.2, sd: 0.6 },
      offset: { mean: 0.3, sd: 0.2 },
      difficulty: { mean: 0.3, sd: 2.6 },
    };
    const { normal } = generator(3);
    let sum = 0;
    const n = 200_000;
    for (let i = 0; i < n; i += 1) {
      const margin =
        chance.ability.mean +
        chance.ability.sd * normal() +
        chance.offset.mean +
        chance.offset.sd * normal() -
        (chance.difficulty.mean + chance.difficulty.sd * normal());
      sum += sigmoid(margin);
    }
    expect(passProbability(chance)).toBeCloseTo(sum / n, 2);
  });

  it("asks more of uncertain models at a pessimistic quantile", () => {
    const sure = { ability: { mean: 1, sd: 0.1 }, offset: exact(0), difficulty: { mean: 0, sd: 1 } };
    const unsure = { ...sure, ability: { mean: 1, sd: 1 } };
    expect(passProbabilityAt(sure, 0.5)).toBeCloseTo(passProbabilityAt(unsure, 0.5));
    expect(passProbabilityAt(unsure, 0.1)).toBeLessThan(passProbabilityAt(sure, 0.1));
  });
});

describe("bandForScore", () => {
  it("maps routing scores onto difficulty bands", () => {
    expect([0, 2, 3, 5, 6, 7, 8, 13].map((score) => bandForScore(score, bands).id)).toEqual([
      "lt15m",
      "lt15m",
      "15m-1h",
      "15m-1h",
      "1h-4h",
      "1h-4h",
      "gt4h",
      "gt4h",
    ]);
  });
});

describe("normalQuantile", () => {
  it("inverts the normal distribution", () => {
    expect(normalQuantile(0.5)).toBeCloseTo(0, 8);
    expect(normalQuantile(0.95)).toBeCloseTo(1.6448536, 6);
    expect(normalQuantile(0.1)).toBeCloseTo(-1.2815516, 6);
    expect(normalQuantile(0.001)).toBeCloseTo(-3.0902323, 5);
  });
});

describe("updateAbility", () => {
  const offset: Estimate = { mean: 0.3, sd: 0.2 };

  function simulate(trueAbility: number, count: number, seed: number): Outcome[] {
    const { uniform, normal } = generator(seed);
    return Array.from({ length: count }, (_, i) => {
      const band = bands[i % 3] as DifficultyBand;
      const taskDifficulty = band.difficulty.mean + band.difficulty.sd * normal();
      const agent = offset.mean + offset.sd * normal();
      return { passed: uniform() < sigmoid(trueAbility + agent - taskDifficulty), difficulty: band.difficulty, offset };
    });
  }

  it("leaves the prior alone without outcomes and moves with passes and failures", () => {
    const prior = { mean: 0.5, sd: 1 };
    expect(updateAbility(prior, [])).toEqual(prior);
    const pass = updateAbility(prior, [{ passed: true, difficulty: bands[1]?.difficulty as Estimate, offset }]);
    const fail = updateAbility(prior, [{ passed: false, difficulty: bands[1]?.difficulty as Estimate, offset }]);
    expect(pass.mean).toBeGreaterThan(prior.mean);
    expect(fail.mean).toBeLessThan(prior.mean);
    expect(pass.sd).toBeLessThan(prior.sd);
  });

  it("converges on the true ability as outcomes accumulate", () => {
    const prior = { mean: -0.5, sd: 1.5 };
    const truth = 1.4;
    const few = updateAbility(prior, simulate(truth, 10, 1));
    const many = updateAbility(prior, simulate(truth, 400, 2));
    expect(Math.abs(many.mean - truth)).toBeLessThan(0.4);
    expect(many.sd).toBeLessThan(few.sd);
  });

  it("gives intervals that cover the truth about as often as they claim", () => {
    let covered = 0;
    const users = 300;
    const { normal } = generator(99);
    for (let user = 0; user < users; user += 1) {
      const prior = { mean: 0.8, sd: 1 };
      const truth = prior.mean + prior.sd * normal();
      const posterior = updateAbility(prior, simulate(truth, 25, 1000 + user));
      if (Math.abs(posterior.mean - truth) <= 1.645 * posterior.sd) covered += 1;
    }
    expect(covered / users).toBeGreaterThan(0.85);
    expect(covered / users).toBeLessThan(0.96);
  });
});
