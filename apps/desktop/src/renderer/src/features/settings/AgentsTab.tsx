import { AGENT_NAMES, type AgentConfig, type AgentId, TIERS, type Tier } from "@km0/shared";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { errorMessage } from "@/lib/ipc";
import { useIpcMutation, useIpcQuery } from "@/lib/queries";

export function agentName(id: AgentId, t: (key: string) => string): string {
  return id === "generic" ? t("settings.agents.generic") : AGENT_NAMES[id];
}

/** Which agents get work, in what order, and the model and price each uses per tier. */
export function AgentsTab() {
  const { t } = useTranslation();
  const agents = useIpcQuery("settings.agents.list");
  const move = useIpcMutation("settings.agents.move", ["settings.agents.list"]);
  const list = agents.data ?? [];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t("settings.agents.intro")}</p>
      {list.map((agent, index) => (
        <AgentCard
          key={agent.id}
          agent={agent}
          first={index === 0}
          last={index === list.length - 1}
          onMove={(direction) => move.mutate({ id: agent.id, direction })}
        />
      ))}
    </div>
  );
}

type Draft = Record<Tier, { modelId: string; priceIn: string; priceOut: string }>;

function toDraft(agent: AgentConfig): Draft {
  const entry = (tier: Tier) => {
    const model = agent.models[tier];
    return {
      modelId: model?.modelId ?? "",
      priceIn: model?.priceInPerMTok?.toString() ?? "",
      priceOut: model?.priceOutPerMTok?.toString() ?? "",
    };
  };
  return { T1: entry("T1"), T2: entry("T2"), T3: entry("T3") };
}

function parsePrice(value: string): number | null | "invalid" {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : "invalid";
}

function AgentCard({
  agent,
  first,
  last,
  onMove,
}: {
  agent: AgentConfig;
  first: boolean;
  last: boolean;
  onMove: (direction: "up" | "down") => void;
}) {
  const { t } = useTranslation();
  const update = useIpcMutation("settings.agents.update", ["settings.agents.list"]);
  const [enabled, setEnabled] = useState(agent.enabled);
  const [draft, setDraft] = useState<Draft>(() => toDraft(agent));
  const name = agentName(agent.id, t);
  const dirty = enabled !== agent.enabled || JSON.stringify(draft) !== JSON.stringify(toDraft(agent));
  const invalid = TIERS.some(
    (tier) => parsePrice(draft[tier].priceIn) === "invalid" || parsePrice(draft[tier].priceOut) === "invalid",
  );

  const save = () => {
    const models = Object.fromEntries(
      TIERS.map((tier) => {
        const entry = draft[tier];
        if (!entry.modelId.trim()) return [tier, null];
        return [
          tier,
          {
            modelId: entry.modelId.trim(),
            priceInPerMTok: parsePrice(entry.priceIn) as number | null,
            priceOutPerMTok: parsePrice(entry.priceOut) as number | null,
          },
        ];
      }),
    ) as AgentConfig["models"];
    update.mutate(
      { id: agent.id, enabled, models },
      {
        // Show the values as stored, so "3.0" becomes "3" and the form is clean again.
        onSuccess: (list) => {
          const saved = list.find((item) => item.id === agent.id);
          if (saved) setDraft(toDraft(saved));
        },
      },
    );
  };

  const set = (tier: Tier, field: keyof Draft[Tier], value: string) =>
    setDraft((current) => ({ ...current, [tier]: { ...current[tier], [field]: value } }));

  return (
    <section aria-label={name} className="rounded-lg border border-border bg-panel p-4">
      <div className="flex items-center justify-between gap-3">
        <label className="flex items-center gap-2 font-medium">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          {name}
        </label>
        <div className="flex gap-1">
          <Button
            size="icon"
            variant="ghost"
            disabled={first}
            aria-label={t("settings.agents.up")}
            onClick={() => onMove("up")}
          >
            <ArrowUp />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            disabled={last}
            aria-label={t("settings.agents.down")}
            onClick={() => onMove("down")}
          >
            <ArrowDown />
          </Button>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-[2.5rem_1fr_7rem_7rem] items-center gap-2 text-xs">
        <span />
        <span className="text-muted">{t("settings.agents.model")}</span>
        <span className="text-muted">{t("settings.agents.priceIn")}</span>
        <span className="text-muted">{t("settings.agents.priceOut")}</span>
        {TIERS.map((tier) => (
          <div key={tier} className="contents">
            <span className="font-medium">{tier}</span>
            <Input
              className="h-8"
              aria-label={`${name} ${tier} ${t("settings.agents.model")}`}
              placeholder={t(`settings.agents.tierHint.${tier}`)}
              value={draft[tier].modelId}
              onChange={(event) => set(tier, "modelId", event.target.value)}
            />
            <Input
              className="h-8"
              inputMode="decimal"
              aria-label={`${name} ${tier} ${t("settings.agents.priceIn")}`}
              value={draft[tier].priceIn}
              onChange={(event) => set(tier, "priceIn", event.target.value)}
            />
            <Input
              className="h-8"
              inputMode="decimal"
              aria-label={`${name} ${tier} ${t("settings.agents.priceOut")}`}
              value={draft[tier].priceOut}
              onChange={(event) => set(tier, "priceOut", event.target.value)}
            />
          </div>
        ))}
      </div>
      {dirty || update.error ? (
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" variant="primary" disabled={!dirty || invalid || update.isPending} onClick={save}>
            {t("settings.agents.save")}
          </Button>
          {invalid ? <span className="text-xs text-danger">{t("settings.form.invalidNumber")}</span> : null}
          {update.error ? <span className="text-xs text-danger">{errorMessage(update.error)}</span> : null}
        </div>
      ) : null}
    </section>
  );
}
