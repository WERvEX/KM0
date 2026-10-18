import { type AgentConfig, AgentId, AppError, TIERS, type Tier, type TierModel } from "@km0/shared";
import { type Database, transaction } from "../db/sql";

interface AgentRow {
  id: AgentId;
  enabled: number;
  preference: number;
}

interface CatalogRow {
  agent_id: AgentId;
  tier: Tier;
  model_id: string;
  price_in_per_mtok: number | null;
  price_out_per_mtok: number | null;
}

/** Which agents may receive work, in what order, and the model and price per tier for each. */
export class AgentStore {
  constructor(private readonly db: Database) {}

  list(): AgentConfig[] {
    const rows = this.db.prepare("SELECT id, enabled, preference FROM agents").all() as unknown as AgentRow[];
    const catalog = this.db.prepare("SELECT * FROM model_catalog").all() as unknown as CatalogRow[];
    return rows
      .filter((row) => AgentId.safeParse(row.id).success)
      .sort((a, b) => a.preference - b.preference)
      .map((row) => {
        const models = { T1: null, T2: null, T3: null } as Record<Tier, TierModel | null>;
        for (const entry of catalog.filter((item) => item.agent_id === row.id)) {
          models[entry.tier] = {
            modelId: entry.model_id,
            priceInPerMTok: entry.price_in_per_mtok,
            priceOutPerMTok: entry.price_out_per_mtok,
          };
        }
        return { id: row.id, enabled: row.enabled === 1, preference: row.preference, models };
      });
  }

  update(id: AgentId, enabled: boolean, models: AgentConfig["models"]): AgentConfig[] {
    this.require(id);
    transaction(this.db, () => {
      this.db.prepare("UPDATE agents SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
      this.db.prepare("DELETE FROM model_catalog WHERE agent_id = ?").run(id);
      for (const tier of TIERS) {
        const model = models[tier];
        if (!model) continue;
        this.db
          .prepare(
            "INSERT INTO model_catalog (agent_id, tier, model_id, price_in_per_mtok, price_out_per_mtok) VALUES (?, ?, ?, ?, ?)",
          )
          .run(id, tier, model.modelId, model.priceInPerMTok, model.priceOutPerMTok);
      }
    });
    return this.list();
  }

  /** Swap an agent with its neighbour in the preference order. */
  move(id: AgentId, direction: "up" | "down"): AgentConfig[] {
    this.require(id);
    const order = this.list();
    const index = order.findIndex((agent) => agent.id === id);
    const other = order[direction === "up" ? index - 1 : index + 1];
    if (!other) return order;
    transaction(this.db, () => {
      // Renumber everything so equal or sparse preferences cannot get stuck.
      const ids = order.map((agent) => agent.id);
      const target = ids.indexOf(other.id);
      [ids[index], ids[target]] = [ids[target] as AgentId, ids[index] as AgentId];
      ids.forEach((agentId, position) => {
        this.db.prepare("UPDATE agents SET preference = ? WHERE id = ?").run(position, agentId);
      });
    });
    return this.list();
  }

  /** Put the listed agents first, in this order; the rest keep their relative order after them. */
  reorder(ids: AgentId[]): AgentConfig[] {
    const known = this.list().map((agent) => agent.id);
    const first = ids.filter((id, index) => known.includes(id) && ids.indexOf(id) === index);
    const order = [...first, ...known.filter((id) => !first.includes(id))];
    transaction(this.db, () => {
      order.forEach((agentId, position) => {
        this.db.prepare("UPDATE agents SET preference = ? WHERE id = ?").run(position, agentId);
      });
    });
    return this.list();
  }

  private require(id: AgentId): void {
    if (!this.db.prepare("SELECT 1 FROM agents WHERE id = ?").get(id)) {
      throw new AppError("not_found", `Unknown agent: ${id}`);
    }
  }
}
