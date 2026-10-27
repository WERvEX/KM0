import type { SweBenchRaw } from "./sources";

/**
 * Task difficulty from SWE-bench Verified's per-task results. A Rasch model, P(run s solves task i)
 * = σ(θ_s − b_i), is fitted to every mini-SWE-agent run that published which tasks it solved. Each
 * task's difficulty b_i then joins its human time estimate, giving a difficulty distribution per
 * time band, and each run's θ_s joins its overall resolved rate, giving the link from the ability
 * scale of the joint fit (logit of the Verified resolved rate) to the Rasch scale.
 */

export const BANDS = [
  { id: "lt15m", label: "<15 min fix", maxScore: 2 },
  { id: "15m-1h", label: "15 min - 1 hour", maxScore: 5 },
  { id: "1h-4h", label: "1-4 hours", maxScore: 7 },
  { id: "gt4h", label: ">4 hours", maxScore: null },
] as const;

export interface DifficultyFit {
  bands: { id: (typeof BANDS)[number]["id"]; maxScore: number | null; mean: number; sd: number; tasks: number }[];
  /** Rasch ability = intercept + slope · logit(Verified resolved rate). */
  link: { intercept: number; slope: number; residualSd: number; runs: number };
  /** Mean task difficulty by files the reference patch changes (1, 2, 3–5, 6+), for the report. */
  byFiles: { files: string; mean: number; tasks: number }[];
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const logit = (p: number) => Math.log(p / (1 - p));

export function fitDifficulty(raw: SweBenchRaw, iterations = 200): DifficultyFit {
  // Per-task results must agree with the published rate; some submissions publish broken details.
  const agrees = (solved: string, resolved: number) =>
    Math.abs((100 * [...solved].filter((c) => c === "1").length) / solved.length - resolved) <= 2;
  const runs = raw.submissions.filter(
    (s) =>
      s.board === "Verified" &&
      s.solved &&
      /mini-swe-agent/i.test(s.agent) &&
      s.solved.length === raw.tasks.length &&
      agrees(s.solved, s.resolved),
  );
  if (runs.length < 5) throw new Error(`Only ${runs.length} SWE-bench Verified runs publish per-task results`);
  const tasks = raw.tasks;
  const solved = runs.map((run) => Array.from(run.solved as string, (c) => c === "1"));
  const theta = new Float64Array(runs.length);
  const b = new Float64Array(tasks.length);
  // Weak priors keep tasks that every run (or no run) solved finite.
  const priorTheta = 1 / 3 ** 2;
  const priorB = 1 / 3 ** 2;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (let s = 0; s < runs.length; s += 1) {
      let gradient = -(theta[s] as number) * priorTheta;
      let hessian = priorTheta;
      for (let i = 0; i < tasks.length; i += 1) {
        const p = sigmoid((theta[s] as number) - (b[i] as number));
        gradient += (solved[s]?.[i] ? 1 : 0) - p;
        hessian += p * (1 - p);
      }
      theta[s] = (theta[s] as number) + gradient / hessian;
    }
    for (let i = 0; i < tasks.length; i += 1) {
      let gradient = -(b[i] as number) * priorB;
      let hessian = priorB;
      for (let s = 0; s < runs.length; s += 1) {
        const p = sigmoid((theta[s] as number) - (b[i] as number));
        gradient += p - (solved[s]?.[i] ? 1 : 0);
        hessian += p * (1 - p);
      }
      b[i] = (b[i] as number) + gradient / hessian;
    }
  }

  const bands = BANDS.map((band) => {
    const values = tasks.flatMap((task, i) => (task.difficulty === band.label ? [b[i] as number] : []));
    return { id: band.id, maxScore: band.maxScore, ...meanSd(values), tasks: values.length };
  });
  // A band with very few tasks borrows the spread of its neighbour and is pushed at least half a logit harder.
  for (let k = 1; k < bands.length; k += 1) {
    const band = bands[k];
    const previous = bands[k - 1];
    if (band && previous && band.tasks < 10) {
      band.sd = Math.max(band.sd, previous.sd);
      band.mean = Math.max(band.mean, previous.mean + 0.5);
    }
  }

  const xs = runs.map((run) => logit(Math.min(0.995, Math.max(0.005, run.resolved / 100))));
  const ys = Array.from(theta);
  const line = fitLine(xs, ys);
  const byFiles = [
    { files: "1", test: (n: number) => n === 1 },
    { files: "2", test: (n: number) => n === 2 },
    { files: "3-5", test: (n: number) => n >= 3 && n <= 5 },
    { files: "6+", test: (n: number) => n >= 6 },
  ].map(({ files, test }) => {
    const values = tasks.flatMap((task, i) => (test(task.files) ? [b[i] as number] : []));
    return { files, mean: meanSd(values).mean, tasks: values.length };
  });
  return { bands, link: { ...line, runs: runs.length }, byFiles };
}

function meanSd(values: number[]): { mean: number; sd: number } {
  if (values.length === 0) return { mean: 0, sd: 0 };
  const mean = values.reduce((a, v) => a + v, 0) / values.length;
  const variance = values.reduce((a, v) => a + (v - mean) ** 2, 0) / Math.max(1, values.length - 1);
  return { mean, sd: Math.sqrt(variance) };
}

function fitLine(xs: number[], ys: number[]): { intercept: number; slope: number; residualSd: number } {
  const n = xs.length;
  const mx = xs.reduce((a, v) => a + v, 0) / n;
  const my = ys.reduce((a, v) => a + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += ((xs[i] as number) - mx) ** 2;
    sxy += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
  }
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let rss = 0;
  for (let i = 0; i < n; i += 1) rss += ((ys[i] as number) - intercept - slope * (xs[i] as number)) ** 2;
  return { intercept, slope, residualSd: Math.sqrt(rss / Math.max(1, n - 2)) };
}
