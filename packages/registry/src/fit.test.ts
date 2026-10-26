import { describe, expect, it } from "vitest";
import { type ColumnSpec, fitPrior, type Observation, transform, untransform } from "./fit";

/** A small deterministic generator, so the synthetic data is the same on every run. */
function random(seed: number) {
  let state = seed >>> 0;
  const uniform = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  return () => Math.sqrt(-2 * Math.log(uniform() + 1e-12)) * Math.cos(2 * Math.PI * uniform());
}

const specs: Record<string, ColumnSpec> = {
  anchor: { transform: "rate", capability: "general", weight: 1, anchor: true },
  index: { transform: "index", capability: "general", weight: 1 },
  hard: { transform: "rate", capability: "general", weight: 1 },
  web: { transform: "elo", capability: "frontend", weight: 1 },
  terminal: { transform: "rate", capability: "devops", weight: 1 },
};

/** Synthetic leaderboards with known abilities, column lines and agent offsets. */
function synthetic(seed: number) {
  const noise = random(seed);
  const truth = new Map<string, number>();
  const observations: Observation[] = [];
  const lines: Record<string, [number, number]> = {
    anchor: [0, 1],
    index: [-1.2, 1.5],
    hard: [-1.5, 2.5],
    web: [-0.5, 1.2],
    terminal: [-2.5, 2],
  };
  const nativeOffset = 0.4;
  for (let m = 0; m < 60; m += 1) {
    const model = `v${m % 3}/model-${m}`;
    const theta = noise() * 0.9;
    truth.set(model, theta);
    for (const [column, [alpha, beta]] of Object.entries(lines)) {
      // Each model shows up on about half the boards, like real leaderboards.
      if (column !== "index" && (m * 7 + column.length) % 5 < 2) continue;
      const native = column === "terminal" && m % 3 === 0;
      const latent = theta + (native ? nativeOffset : 0);
      const y = alpha + beta * latent + noise() * 0.15;
      observations.push({
        model,
        column,
        agent: column === "terminal" ? "agent-x" : null,
        native,
        value: untransform(specs[column] as ColumnSpec, y),
      });
    }
  }
  return { truth, observations, nativeOffset };
}

describe("fitPrior", () => {
  it("transforms published values to the logit scale and back", () => {
    for (const spec of Object.values(specs)) {
      expect(untransform(spec, transform(spec, spec.transform === "elo" ? 1320 : 42))).toBeCloseTo(
        spec.transform === "elo" ? 1320 : 42,
      );
    }
  });

  it("recovers abilities and the native agent offset from synthetic leaderboards", () => {
    const { truth, observations, nativeOffset } = synthetic(7);
    const result = fitPrior(observations, specs);
    const pairs = [...truth].map(([model, theta]) => [theta, result.ability.get(model)?.mean ?? Number.NaN]);
    const correlation = pearson(
      pairs.map((p) => p[0] as number),
      pairs.map((p) => p[1] as number),
    );
    expect(correlation).toBeGreaterThan(0.97);

    const native = result.agent.get("agent-x|native");
    const foreign = result.agent.get("agent-x|foreign");
    expect(native && foreign).toBeTruthy();
    // Offsets are relative to the same agent on other vendors' models.
    expect((native?.mean ?? 0) - (foreign?.mean ?? 0)).toBeGreaterThan(nativeOffset - 0.25);
    expect((native?.mean ?? 0) - (foreign?.mean ?? 0)).toBeLessThan(nativeOffset + 0.25);

    const index = result.columns.get("index");
    expect(index?.beta).toBeGreaterThan(1.2);
    expect(index?.beta).toBeLessThan(1.8);
  });

  it("gives wide intervals to models with little evidence", () => {
    const { observations } = synthetic(11);
    const lonely: Observation = { model: "v9/lonely", column: "index", agent: null, native: false, value: 50 };
    const result = fitPrior([...observations, lonely], specs);
    const many = result.ability.get("v0/model-0");
    const one = result.ability.get("v9/lonely");
    expect(one?.sd).toBeGreaterThan(many?.sd ?? 0);
  });
});

function pearson(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
    sxx += ((xs[i] as number) - mx) ** 2;
    syy += ((ys[i] as number) - my) ** 2;
  }
  return sxy / Math.sqrt(sxx * syy);
}
