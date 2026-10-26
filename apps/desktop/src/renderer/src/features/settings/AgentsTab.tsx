import {
  AGENT_NAMES,
  type AgentConfig,
  type AgentId,
  CAPABILITIES,
  type Capability,
  type RegistryInfo,
  RoutingRules,
  TIERS,
  type Tier,
} from "@km0/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Loader2, RefreshCw, RotateCcw, Upload } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { useFiles } from "@/lib/files";
import { call, errorMessage } from "@/lib/ipc";
import { useIpcMutation, useIpcQuery } from "@/lib/queries";

export function agentName(id: AgentId, t: (key: string) => string): string {
  return id === "generic" ? t("settings.agents.generic") : AGENT_NAMES[id];
}

/** Which agents get work, in what order, what each is good at, and the model and price per tier. */
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
      <RoutingRulesSection />
      <RegistrySection />
    </div>
  );
}

/** The leaderboard data behind the ability priors: how current it is, where it comes from, and updating it. */
function RegistrySection() {
  const { t, i18n } = useTranslation();
  const toast = useToast();
  const files = useFiles();
  const queryClient = useQueryClient();
  const info = useIpcQuery("registry.info");
  const refresh = (next: RegistryInfo) => queryClient.setQueryData(["registry.info"], next);
  const update = useMutation({
    mutationFn: () => call("registry.update", undefined),
    onSuccess: ({ status, info: next }) => {
      refresh(next);
      toast({
        kind: status === "updated" ? "success" : "info",
        message: t(`settings.agents.registry.${status}`, { date: next.dataDate }),
      });
    },
    onError: (error) => toast({ kind: "error", message: errorMessage(error) }),
  });
  const importFile = useMutation({
    mutationFn: async () => {
      const file = await files.openFile({
        title: t("settings.agents.registry.import"),
        extensions: ["json"],
        memoryKey: "registry",
      });
      return file ? call("registry.import", { text: file.text }) : null;
    },
    onSuccess: (next) => {
      if (!next) return;
      refresh(next);
      toast({ kind: "success", message: t("settings.agents.registry.imported", { date: next.dataDate }) });
    },
    onError: (error) => toast({ kind: "error", message: errorMessage(error) }),
  });
  const reset = useMutation({ mutationFn: () => call("registry.reset", undefined), onSuccess: refresh });
  if (!info.data) return null;
  const data = info.data;
  const at = data.importedAt ? new Date(data.importedAt).toLocaleDateString(i18n.language) : "";
  const busy = update.isPending || importFile.isPending || reset.isPending;

  return (
    <section
      aria-label={t("settings.agents.registry.title")}
      className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4"
    >
      <h2 className="text-sm font-semibold">{t("settings.agents.registry.title")}</h2>
      <p className="text-sm text-muted">{t("settings.agents.registry.body")}</p>
      <p className="text-sm">
        {t("settings.agents.registry.dataDate", { date: data.dataDate })}
        {" · "}
        {t(`settings.agents.registry.origin.${data.origin}`, { at })}
      </p>
      <p className="text-sm text-muted">{t("settings.agents.registry.models", data.models)}</p>
      <div>
        <h3 className="text-xs font-medium text-muted">{t("settings.agents.registry.sources")}</h3>
        <ul className="mt-1 flex flex-col gap-0.5 text-sm">
          {data.sources.map((source) => (
            <li key={source.url} className="flex flex-wrap gap-x-2">
              <a href={source.url} target="_blank" rel="noreferrer" className="text-accent hover:underline">
                {source.name}
              </a>
              {source.newestEntry ? (
                <span className="text-muted">{t("settings.agents.registry.newest", { date: source.newestEntry })}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" onClick={() => update.mutate()} disabled={busy}>
          {update.isPending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          {t("settings.agents.registry.update")}
        </Button>
        <Button size="sm" onClick={() => importFile.mutate()} disabled={busy}>
          <Upload />
          {t("settings.agents.registry.import")}
        </Button>
        {data.origin !== "bundled" ? (
          <Button size="sm" onClick={() => reset.mutate()} disabled={busy}>
            <RotateCcw />
            {t("settings.agents.registry.reset")}
          </Button>
        ) : null}
      </div>
    </section>
  );
}

/** Tier limits in use, and importing the rules a KM0 Runner calibration wrote. */
function RoutingRulesSection() {
  const { t } = useTranslation();
  const state = useIpcQuery("settings.routingRules.get");
  const set = useIpcMutation("settings.routingRules.set", ["settings.routingRules.get", "routing.get"]);
  const files = useFiles();
  const [invalid, setInvalid] = useState(false);
  if (!state.data) return null;
  const { rules, custom } = state.data;

  const importRules = async () => {
    setInvalid(false);
    let file: { text: string } | null;
    try {
      file = await files.openFile({
        title: t("settings.agents.rules.import"),
        extensions: ["json"],
        memoryKey: "rules",
      });
    } catch {
      setInvalid(true);
      return;
    }
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(file.text);
    } catch {
      parsed = null;
    }
    const result = RoutingRules.safeParse(parsed);
    if (!result.success) {
      setInvalid(true);
      return;
    }
    set.mutate(result.data);
  };

  return (
    <section
      aria-label={t("settings.agents.rules.title")}
      className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4"
    >
      <h2 className="text-sm font-semibold">{t("settings.agents.rules.title")}</h2>
      <p className="text-sm text-muted">{t("settings.agents.rules.body")}</p>
      <p className="text-sm">
        {t(custom ? "settings.agents.rules.custom" : "settings.agents.rules.default")}
        {" · "}
        {t("settings.agents.rules.limits", { t1: rules.tierLimits.T1, t2: rules.tierLimits.T2 })}
      </p>
      <div className="flex gap-2">
        <Button size="sm" onClick={() => void importRules()} disabled={set.isPending}>
          <Upload />
          {t("settings.agents.rules.import")}
        </Button>
        {custom ? (
          <Button size="sm" onClick={() => set.mutate(null)} disabled={set.isPending}>
            <RotateCcw />
            {t("settings.agents.rules.reset")}
          </Button>
        ) : null}
      </div>
      {invalid ? <p className="text-sm text-danger">{t("settings.agents.rules.invalid")}</p> : null}
      {set.error ? <p className="text-sm text-danger">{errorMessage(set.error)}</p> : null}
    </section>
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
  const [capabilities, setCapabilities] = useState<Capability[]>(agent.capabilities);
  const name = agentName(agent.id, t);
  const sameCapabilities =
    capabilities.length === agent.capabilities.length &&
    capabilities.every((item) => agent.capabilities.includes(item));
  const dirty =
    enabled !== agent.enabled || !sameCapabilities || JSON.stringify(draft) !== JSON.stringify(toDraft(agent));
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
      { id: agent.id, enabled, models, capabilities },
      {
        // Show the values as stored, so "3.0" becomes "3" and the form is clean again.
        onSuccess: (list) => {
          const saved = list.find((item) => item.id === agent.id);
          if (saved) {
            setDraft(toDraft(saved));
            setCapabilities(saved.capabilities);
          }
        },
      },
    );
  };

  const set = (tier: Tier, field: keyof Draft[Tier], value: string) =>
    setDraft((current) => ({ ...current, [tier]: { ...current[tier], [field]: value } }));
  const toggle = (capability: Capability, on: boolean) =>
    setCapabilities((current) =>
      on
        ? CAPABILITIES.filter((item) => item === capability || current.includes(item))
        : current.filter((item) => item !== capability),
    );

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
      <fieldset className="mt-3">
        <legend className="sr-only">{`${name} ${t("settings.agents.capabilities")}`}</legend>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
          <span aria-hidden="true" className="text-muted">
            {t("settings.agents.capabilities")}
          </span>
          {CAPABILITIES.map((capability) => (
            <label key={capability} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={capabilities.includes(capability)}
                onChange={(event) => toggle(capability, event.target.checked)}
              />
              {t(`settings.agents.capability.${capability}`)}
            </label>
          ))}
        </div>
      </fieldset>
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
