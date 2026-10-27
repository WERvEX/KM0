import {
  type AgentConfig,
  CAPABILITIES,
  type Capability,
  type CustomAgentInput,
  type ModelEntry,
  type ProviderKind,
  type RegistryInfo,
  RoutingRules,
} from "@km0/shared";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Loader2, Pencil, Plus, RefreshCw, RotateCcw, Trash2, Upload } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge, TierBadge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { useFiles } from "@/lib/files";
import { call, errorMessage } from "@/lib/ipc";
import { useIpcMutation, useIpcQuery } from "@/lib/queries";

/** Which agents get work, in what order, what each is good at, and which model it runs per tier. */
export function AgentsTab() {
  const { t } = useTranslation();
  const agents = useIpcQuery("settings.agents.list");
  const models = useIpcQuery("settings.models.list");
  const move = useIpcMutation("settings.agents.move", ["settings.agents.list"]);
  const create = useIpcMutation("settings.agents.create", ["settings.agents.list"]);
  const redefine = useIpcMutation("settings.agents.redefine", ["settings.agents.list"]);
  const remove = useIpcMutation("settings.agents.delete", ["settings.agents.list"]);
  const [editing, setEditing] = useState<{ agent: AgentConfig | null } | null>(null);
  const [deleting, setDeleting] = useState<AgentConfig | null>(null);
  const list = agents.data ?? [];
  const close = () => setEditing(null);
  const saveError = create.error ?? redefine.error;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm text-muted">{t("settings.agents.intro")}</p>
        <Button size="sm" onClick={() => setEditing({ agent: null })}>
          <Plus />
          {t("settings.agents.addCustom")}
        </Button>
      </div>
      {list.map((agent, index) => (
        <AgentCard
          key={`${agent.id}-${agent.name}`}
          agent={agent}
          models={models.data ?? []}
          first={index === 0}
          last={index === list.length - 1}
          onMove={(direction) => move.mutate({ id: agent.id, direction })}
          onEdit={() => setEditing({ agent })}
          onDelete={() => setDeleting(agent)}
        />
      ))}
      <RoutingRulesSection />
      <RegistrySection />

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && close()}
        title={t(editing?.agent ? "settings.agents.customForm.editTitle" : "settings.agents.customForm.createTitle")}
        wide
      >
        {editing ? (
          <CustomAgentForm
            key={editing.agent?.id ?? "new"}
            agent={editing.agent}
            submitting={create.isPending || redefine.isPending}
            error={saveError ? errorMessage(saveError) : null}
            onCancel={close}
            onSubmit={(data) => {
              if (editing.agent) redefine.mutate({ id: editing.agent.id, data }, { onSuccess: close });
              else create.mutate(data, { onSuccess: close });
            }}
          />
        ) : null}
      </Dialog>
      <ConfirmDialog
        open={deleting !== null}
        title={t("settings.agents.deleteCustomTitle")}
        description={t("settings.agents.deleteCustomBody", { name: deleting?.name ?? "" })}
        confirmLabel={t("settings.agents.deleteCustom")}
        cancelLabel={t("settings.agents.customForm.cancel")}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate({ id: deleting.id }, { onSuccess: () => setDeleting(null) })}
      />
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

/** The model entries an agent may run, in a stable order so drafts compare by value. */
type Draft = number[];

const toDraft = (agent: AgentConfig): Draft => agent.models.map((model) => model.modelRef).sort((a, b) => a - b);

function AgentCard({
  agent,
  models,
  first,
  last,
  onMove,
  onEdit,
  onDelete,
}: {
  agent: AgentConfig;
  models: ModelEntry[];
  first: boolean;
  last: boolean;
  onMove: (direction: "up" | "down") => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const update = useIpcMutation("settings.agents.update", ["settings.agents.list"]);
  const [enabled, setEnabled] = useState(agent.enabled);
  const [draft, setDraft] = useState<Draft>(() => toDraft(agent));
  const [capabilities, setCapabilities] = useState<Capability[]>(agent.capabilities);
  const name = agent.id === "generic" ? t("settings.agents.generic") : agent.name;
  const sameCapabilities =
    capabilities.length === agent.capabilities.length &&
    capabilities.every((item) => agent.capabilities.includes(item));
  const dirty =
    enabled !== agent.enabled || !sameCapabilities || JSON.stringify(draft) !== JSON.stringify(toDraft(agent));
  const usable = (model: ModelEntry) => agent.apiKinds.length === 0 || agent.apiKinds.includes(model.providerKind);
  const native = (model: ModelEntry) => model.vendor !== null && agent.nativeVendors.includes(model.vendor);
  // Native models first, then the rest; models of another API format cannot be chosen.
  const options = [...models].sort((a, b) => Number(native(b)) - Number(native(a)) || a.name.localeCompare(b.name));

  const save = () =>
    update.mutate(
      { id: agent.id, enabled, models: draft, capabilities },
      {
        onSuccess: (list) => {
          const saved = list.find((item) => item.id === agent.id);
          if (saved) {
            setDraft(toDraft(saved));
            setCapabilities(saved.capabilities);
          }
        },
      },
    );
  const toggle = (capability: Capability, on: boolean) =>
    setCapabilities((current) =>
      on
        ? CAPABILITIES.filter((item) => item === capability || current.includes(item))
        : current.filter((item) => item !== capability),
    );

  return (
    <section aria-label={name} className="rounded-lg border border-border bg-panel p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <label className="flex items-center gap-2 font-medium">
            <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
            {name}
          </label>
          {agent.kind === "custom" ? (
            <span className="rounded bg-sunken px-1.5 py-0.5 text-[11px] text-muted">
              {t("settings.agents.custom")}
            </span>
          ) : null}
          {agent.apiKinds.length > 0 ? (
            <span className="text-xs text-muted">
              {t("settings.agents.needsKind", {
                kinds: agent.apiKinds.map((kind) => t(`settings.providerForm.kinds.${kind}`)).join(" / "),
              })}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 gap-1">
          {agent.kind === "custom" ? (
            <>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`${t("settings.agents.editCustom")} ${name}`}
                onClick={onEdit}
              >
                <Pencil />
              </Button>
              <Button
                size="icon"
                variant="ghost"
                aria-label={`${t("settings.agents.deleteCustom")} ${name}`}
                onClick={onDelete}
              >
                <Trash2 />
              </Button>
            </>
          ) : null}
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
      <fieldset className="mt-3">
        <legend className="mb-1.5 text-xs text-muted">{t("settings.agents.models")}</legend>
        {options.length === 0 ? (
          <p className="text-xs text-muted">{t("settings.agents.noModels")}</p>
        ) : (
          <ul className="grid gap-1 text-xs sm:grid-cols-2">
            {options.map((model) => (
              <li key={model.id} className="flex min-w-0 items-center gap-2">
                <label className={cn("flex min-w-0 items-center gap-1.5", !usable(model) && "text-muted")}>
                  <input
                    type="checkbox"
                    disabled={!usable(model)}
                    checked={draft.includes(model.id)}
                    onChange={(event) =>
                      setDraft((current) =>
                        event.target.checked
                          ? [...current, model.id].sort((a, b) => a - b)
                          : current.filter((id) => id !== model.id),
                      )
                    }
                  />
                  <span className="truncate">{model.name}</span>
                </label>
                <TierBadge tier={model.tier} />
                {!usable(model) ? (
                  <span className="text-muted">{t("settings.agents.incompatible")}</span>
                ) : native(model) ? (
                  <Badge tone="success">{t("settings.agents.native")}</Badge>
                ) : model.vendor && agent.nativeVendors.length > 0 ? (
                  // Another vendor's model in a vendor's own agent: allowed, but worth knowing.
                  <Badge tone="warning" title={t("settings.agents.notNative", { agent: name })}>
                    {t("settings.agents.foreign")}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      {dirty || update.error ? (
        <div className="mt-3 flex items-center gap-3">
          <Button size="sm" variant="primary" disabled={!dirty || update.isPending} onClick={save}>
            {t("settings.agents.save")}
          </Button>
          {update.error ? <span className="text-xs text-danger">{errorMessage(update.error)}</span> : null}
        </div>
      ) : null}
    </section>
  );
}

/** An agent the user adds: its name, the file it reads, how it is started, and whose official tool it is. */
function CustomAgentForm({
  agent,
  submitting,
  error,
  onSubmit,
  onCancel,
}: {
  agent: AgentConfig | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: CustomAgentInput) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const vendors = useIpcQuery("registry.vendors");
  const [name, setName] = useState(agent?.name ?? "");
  const [instructionFile, setInstructionFile] = useState(agent?.instructionFile ?? "");
  const [launchTemplate, setLaunchTemplate] = useState(agent?.launchTemplate ?? "");
  const [apiKinds, setApiKinds] = useState<ProviderKind[]>(agent?.apiKinds ?? []);
  const [nativeVendor, setNativeVendor] = useState(agent?.nativeVendors[0] ?? "");
  const [capabilities, setCapabilities] = useState<Capability[]>(agent?.capabilities ?? []);

  return (
    <form
      className="grid grid-cols-2 gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (!name.trim()) return;
        onSubmit({
          name: name.trim(),
          instructionFile: instructionFile.trim() || null,
          launchTemplate: launchTemplate.trim() || null,
          apiKinds,
          nativeVendor: nativeVendor || null,
          capabilities,
        });
      }}
    >
      <Field label={t("settings.agents.customForm.name")} htmlFor="custom-name" className="col-span-2">
        <Input id="custom-name" value={name} maxLength={60} onChange={(event) => setName(event.target.value)} />
      </Field>
      <Field
        label={t("settings.agents.customForm.instructionFile")}
        htmlFor="custom-instructions"
        hint={t("settings.agents.customForm.instructionFileHint")}
      >
        <Input
          id="custom-instructions"
          value={instructionFile}
          onChange={(event) => setInstructionFile(event.target.value)}
        />
      </Field>
      <Field
        label={t("settings.agents.customForm.nativeVendor")}
        htmlFor="custom-vendor"
        hint={t("settings.agents.customForm.nativeVendorHint")}
      >
        <Select id="custom-vendor" value={nativeVendor} onChange={(event) => setNativeVendor(event.target.value)}>
          <option value="">{t("settings.agents.customForm.none")}</option>
          {(vendors.data ?? []).map((vendor) => (
            <option key={vendor.id} value={vendor.id}>
              {vendor.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t("settings.agents.customForm.launchTemplate")}
        htmlFor="custom-launch"
        hint={t("settings.agents.customForm.launchTemplateHint")}
        className="col-span-2"
      >
        <Input
          id="custom-launch"
          className="font-mono text-xs"
          spellCheck={false}
          value={launchTemplate}
          placeholder="gemini --model {model} -p {prompt}"
          onChange={(event) => setLaunchTemplate(event.target.value)}
        />
      </Field>
      <fieldset className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <legend className="mb-1.5 text-xs font-medium text-muted">{t("settings.agents.customForm.apiKinds")}</legend>
        {(["openai", "anthropic"] as const).map((kind) => (
          <label key={kind} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={apiKinds.includes(kind)}
              onChange={(event) =>
                setApiKinds((current) =>
                  event.target.checked ? [...current, kind] : current.filter((k) => k !== kind),
                )
              }
            />
            {t(`settings.providerForm.kinds.${kind}`)}
          </label>
        ))}
        {apiKinds.length === 0 ? (
          <span className="text-xs text-muted">({t("settings.agents.customForm.anyKind")})</span>
        ) : null}
      </fieldset>
      <fieldset className="col-span-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        <legend className="mb-1.5 text-xs font-medium text-muted">{t("settings.agents.capabilities")}</legend>
        {CAPABILITIES.map((capability) => (
          <label key={capability} className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={capabilities.includes(capability)}
              onChange={(event) =>
                setCapabilities((current) =>
                  event.target.checked
                    ? CAPABILITIES.filter((item) => item === capability || current.includes(item))
                    : current.filter((item) => item !== capability),
                )
              }
            />
            {t(`settings.agents.capability.${capability}`)}
          </label>
        ))}
      </fieldset>
      {error ? <p className="col-span-2 text-sm text-danger">{error}</p> : null}
      <div className="col-span-2 flex justify-end gap-2">
        <Button onClick={onCancel}>{t("settings.agents.customForm.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={submitting || !name.trim()}>
          {t("settings.agents.customForm.save")}
        </Button>
      </div>
    </form>
  );
}
