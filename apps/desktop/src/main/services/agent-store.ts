import {
  type AgentConfig,
  type AgentId,
  AppError,
  Capability,
  CustomAgentInput,
  isPresetAgent,
  type ModelEntry,
  PRESET_AGENTS,
  ProviderKind,
  type TierModel,
} from "@km0/shared";
import { type Database, transaction } from "../db/sql";

interface AgentRow {
  id: AgentId;
  name: string | null;
  kind: "preset" | "custom";
  enabled: number;
  preference: number;
  capabilities_json: string;
  instruction_file: string | null;
  launch_template: string | null;
  native_vendor: string | null;
  api_kinds_json: string;
}

/** Stored values of a JSON array column, dropping any this version does not know. */
function parseList<T>(json: string, check: (item: unknown) => item is T): T[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter(check) : [];
  } catch {
    return [];
  }
}
const isCapability = (item: unknown): item is Capability => Capability.safeParse(item).success;
const isKind = (item: unknown): item is ProviderKind => ProviderKind.safeParse(item).success;

/** The model an agent runs, with what makes it a good or poor fit for that agent. */
export function tierModel(agent: Pick<AgentConfig, "nativeVendors">, model: ModelEntry): TierModel {
  return {
    modelRef: model.id,
    providerId: model.providerId,
    providerKind: model.providerKind,
    modelId: model.modelId,
    name: model.name,
    canonicalId: model.canonicalId,
    vendor: model.vendor,
    native: model.vendor !== null && agent.nativeVendors.includes(model.vendor),
    price: model.effective,
    priceInPerMTok: model.effective.input,
    priceOutPerMTok: model.effective.output,
    tier: model.tier,
    contextWindow: model.contextWindow,
  };
}

/** A lower-case ID for a custom agent from its name; names in other scripts get a numbered ID. */
function slug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  return base && /^[a-z]/.test(base) ? base : `agent-${base || "custom"}`;
}

/**
 * Which agents may receive work, in what order, what each is good at and which models it can run.
 * The presets are KM0's own adapters; custom agents are whatever the user adds.
 */
export class AgentStore {
  constructor(
    private readonly db: Database,
    private readonly models: () => ModelEntry[] = () => [],
  ) {}

  list(): AgentConfig[] {
    const rows = this.db.prepare("SELECT * FROM agents").all() as unknown as AgentRow[];
    const assignments = this.db.prepare("SELECT agent_id, model_ref FROM agent_models ORDER BY rowid").all() as {
      agent_id: string;
      model_ref: number;
    }[];
    const models = new Map(this.models().map((model) => [model.id, model]));
    return rows
      .filter((row) => row.kind === "custom" || isPresetAgent(row.id))
      .sort((a, b) => a.preference - b.preference)
      .map((row) => {
        const preset = isPresetAgent(row.id) && row.kind === "preset" ? PRESET_AGENTS[row.id] : null;
        const nativeVendors = preset ? preset.nativeVendors : row.native_vendor ? [row.native_vendor] : [];
        const config: AgentConfig = {
          id: row.id,
          name: row.name ?? row.id,
          kind: row.kind,
          enabled: row.enabled === 1,
          preference: row.preference,
          models: [],
          capabilities: parseList(row.capabilities_json, isCapability),
          nativeVendors,
          apiKinds: preset ? preset.apiKinds : parseList(row.api_kinds_json, isKind),
          instructionFile: row.instruction_file,
          launchTemplate: row.launch_template,
        };
        for (const assignment of assignments.filter((item) => item.agent_id === row.id)) {
          const model = models.get(assignment.model_ref);
          if (model) config.models.push(tierModel(config, model));
        }
        return config;
      });
  }

  /** Set what the agent may run. Leaving out `capabilities` keeps the stored ones. */
  update(id: AgentId, enabled: boolean, models: number[], capabilities?: Capability[]): AgentConfig[] {
    const agent = this.require(id);
    const known = new Map(this.models().map((model) => [model.id, model]));
    const refs = [...new Set(models)];
    for (const ref of refs) {
      const model = known.get(ref);
      if (!model) throw new AppError("not_found", `Model ${ref} does not exist.`);
      if (agent.apiKinds.length > 0 && !agent.apiKinds.includes(model.providerKind)) {
        throw new AppError(
          "validation",
          `${agent.name} only works with ${agent.apiKinds.join(" or ")} providers; ${model.name} is ${model.providerKind}.`,
        );
      }
    }
    transaction(this.db, () => {
      this.db.prepare("UPDATE agents SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
      if (capabilities) {
        this.db
          .prepare("UPDATE agents SET capabilities_json = ? WHERE id = ?")
          .run(JSON.stringify([...new Set(capabilities)]), id);
      }
      this.db.prepare("DELETE FROM agent_models WHERE agent_id = ?").run(id);
      for (const ref of refs) {
        this.db.prepare("INSERT INTO agent_models (agent_id, model_ref) VALUES (?, ?)").run(id, ref);
      }
    });
    return this.list();
  }

  createCustom(input: CustomAgentInput): AgentConfig[] {
    const data = CustomAgentInput.parse(input);
    if (this.list().some((agent) => agent.name.toLowerCase() === data.name.toLowerCase())) {
      throw new AppError("conflict", "An agent with this name already exists.");
    }
    let id = slug(data.name);
    for (let n = 2; this.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id); n += 1)
      id = `${slug(data.name)}-${n}`;
    const last = this.db.prepare("SELECT MAX(preference) AS value FROM agents").get() as { value: number | null };
    this.db
      .prepare(
        `INSERT INTO agents (id, name, kind, enabled, preference, capabilities_json, instruction_file, launch_template,
           native_vendor, api_kinds_json)
         VALUES (?, ?, 'custom', 1, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        data.name,
        (last.value ?? 0) + 1,
        JSON.stringify([...new Set(data.capabilities)]),
        data.instructionFile,
        data.launchTemplate,
        data.nativeVendor,
        JSON.stringify([...new Set(data.apiKinds)]),
      );
    return this.list();
  }

  updateCustom(id: AgentId, input: CustomAgentInput): AgentConfig[] {
    const agent = this.require(id);
    if (agent.kind !== "custom") throw new AppError("validation", "Preset agents cannot be redefined.");
    const data = CustomAgentInput.parse(input);
    if (this.list().some((other) => other.id !== id && other.name.toLowerCase() === data.name.toLowerCase())) {
      throw new AppError("conflict", "An agent with this name already exists.");
    }
    this.db
      .prepare(
        `UPDATE agents SET name = ?, capabilities_json = ?, instruction_file = ?, launch_template = ?, native_vendor = ?,
           api_kinds_json = ? WHERE id = ?`,
      )
      .run(
        data.name,
        JSON.stringify([...new Set(data.capabilities)]),
        data.instructionFile,
        data.launchTemplate,
        data.nativeVendor,
        JSON.stringify([...new Set(data.apiKinds)]),
        id,
      );
    return this.list();
  }

  deleteCustom(id: AgentId): AgentConfig[] {
    const agent = this.require(id);
    if (agent.kind !== "custom") throw new AppError("validation", "Preset agents can be disabled but not deleted.");
    this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    return this.list();
  }

  /** Swap an agent with its neighbour in the preference order. */
  move(id: AgentId, direction: "up" | "down"): AgentConfig[] {
    this.require(id);
    const order = this.list();
    const index = order.findIndex((agent) => agent.id === id);
    const other = order[direction === "up" ? index - 1 : index + 1];
    if (!other) return order;
    const ids = order.map((agent) => agent.id);
    const target = ids.indexOf(other.id);
    [ids[index], ids[target]] = [ids[target] as AgentId, ids[index] as AgentId];
    return this.renumber(ids);
  }

  /** Put the listed agents first, in this order; the rest keep their relative order after them. */
  reorder(ids: AgentId[]): AgentConfig[] {
    const known = this.list().map((agent) => agent.id);
    const first = ids.filter((id, index) => known.includes(id) && ids.indexOf(id) === index);
    return this.renumber([...first, ...known.filter((id) => !first.includes(id))]);
  }

  /** Renumber everything so equal or sparse preferences cannot get stuck. */
  private renumber(order: AgentId[]): AgentConfig[] {
    transaction(this.db, () => {
      order.forEach((agentId, position) => {
        this.db.prepare("UPDATE agents SET preference = ? WHERE id = ?").run(position, agentId);
      });
    });
    return this.list();
  }

  private require(id: AgentId): AgentConfig {
    const agent = this.list().find((item) => item.id === id);
    if (!agent) throw new AppError("not_found", `Unknown agent: ${id}`);
    return agent;
  }
}
