import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ModelRegistry } from "@km0/shared";
import { build } from "./build";
import type { Tables } from "./observations";
import { report } from "./report";
import { fetchAll, loadSnapshots } from "./sources";

const root = join(import.meta.dirname, "..");
const dataDir = join(root, "data");
const outDir = join(root, "generated");
const [command, ...flags] = process.argv.slice(2);

async function readTable<T>(name: string): Promise<T> {
  const value = JSON.parse(await readFile(join(dataDir, name), "utf8")) as Record<string, unknown>;
  delete value._comment;
  return value as T;
}

async function buildOutputs(): Promise<{ registry: string; report: string }> {
  const tables: Tables = {
    aliases: await readTable("aliases.json"),
    agents: await readTable("agents.json"),
    vendors: await readTable("vendors.json"),
    columns: await readTable("columns.json"),
  };
  const built = build(await loadSnapshots(join(dataDir, "raw")), tables);
  // The app reads this file; it must pass the same schema the app checks.
  const registry = ModelRegistry.parse(built.registry);
  return { registry: `${JSON.stringify(registry)}\n`, report: report(built) };
}

if (command === "fetch") {
  const failed = await fetchAll(join(dataDir, "raw"), (line) => console.log(line));
  process.exitCode = failed.length > 0 ? 1 : 0;
} else if (command === "build") {
  const outputs = await buildOutputs();
  const files = { "model-registry.json": outputs.registry, "report.md": outputs.report };
  if (flags.includes("--check")) {
    // CI: the committed outputs must be exactly what the committed snapshots produce.
    const stale: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      const current = await readFile(join(outDir, name), "utf8").catch(() => "");
      if (current !== content) stale.push(name);
    }
    if (stale.length > 0) {
      console.error(`Out of date: ${stale.join(", ")}. Run pnpm --filter @km0/registry build and commit the result.`);
      process.exitCode = 1;
    } else {
      console.log("Registry outputs match the snapshots.");
    }
  } else {
    for (const [name, content] of Object.entries(files)) await writeFile(join(outDir, name), content);
    console.log(
      `Wrote generated/model-registry.json (${Math.round(outputs.registry.length / 1024)} KB) and generated/report.md`,
    );
  }
} else {
  console.error("usage: tsx src/cli.ts fetch | build [--check]");
  process.exitCode = 2;
}
