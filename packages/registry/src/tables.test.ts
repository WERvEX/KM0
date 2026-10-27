import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isPresetAgent, PRESET_AGENTS } from "@km0/shared";
import { describe, expect, it } from "vitest";

const read = (name: string) => JSON.parse(readFileSync(join(import.meta.dirname, "../data", name), "utf8"));

describe("data tables", () => {
  it("give KM0's preset agents the same own vendors the app uses", () => {
    const agents = read("agents.json") as { id: string; nativeVendors: string[] }[];
    for (const agent of agents.filter((item) => isPresetAgent(item.id))) {
      expect([agent.id, agent.nativeVendors]).toEqual([
        agent.id,
        PRESET_AGENTS[agent.id as keyof typeof PRESET_AGENTS].nativeVendors,
      ]);
    }
  });

  it("point every vendor's own agents at agents that exist", () => {
    const agents = new Set((read("agents.json") as { id: string }[]).map((agent) => agent.id));
    const vendors = read("vendors.json") as { id: string; nativeAgents: string[] }[];
    for (const vendor of vendors) for (const agent of vendor.nativeAgents) expect(agents).toContain(agent);
  });
});
