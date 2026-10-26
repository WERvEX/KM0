import type { ConnectionTestResult, ModelEntry, ModelInput, Provider, ProviderInput } from "@km0/shared";
import { AlertTriangle, Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select } from "@/components/ui/field";
import { call, errorMessage } from "@/lib/ipc";
import { useIpcMutation, useIpcQuery } from "@/lib/queries";
import { ModelForm } from "./ModelForm";
import { billingSummary, ProviderForm } from "./ProviderForm";

type Editing =
  | { kind: "provider"; provider: Provider | null }
  | { kind: "model"; model: ModelEntry | null; providerId: number | null }
  | null;
type Deleting = { kind: "provider"; provider: Provider } | { kind: "model"; model: ModelEntry } | null;

const REFRESH = [
  "settings.providers.list",
  "settings.models.list",
  "settings.roles.get",
  "settings.agents.list",
] as const;

/** Providers with their models, and which models KM0 uses for its own work. */
export function ModelsTab() {
  const { t } = useTranslation();
  const providers = useIpcQuery("settings.providers.list");
  const models = useIpcQuery("settings.models.list");
  const roles = useIpcQuery("settings.roles.get");
  const refresh = [...REFRESH];
  const createProvider = useIpcMutation("settings.providers.create", refresh);
  const updateProvider = useIpcMutation("settings.providers.update", refresh);
  const deleteProvider = useIpcMutation("settings.providers.delete", refresh);
  const createModel = useIpcMutation("settings.models.create", refresh);
  const updateModel = useIpcMutation("settings.models.update", refresh);
  const deleteModel = useIpcMutation("settings.models.delete", refresh);
  const setRoles = useIpcMutation("settings.roles.set", ["settings.roles.get"]);

  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<Deleting>(null);
  const [tests, setTests] = useState<Record<number, ConnectionTestResult | "running">>({});

  const providerList = providers.data ?? [];
  const modelList = models.data ?? [];
  const close = () => setEditing(null);
  const mutations = [createProvider, updateProvider, createModel, updateModel];
  const saving = mutations.some((mutation) => mutation.isPending);
  const saveError = mutations.find((mutation) => mutation.error)?.error;

  const saveProvider = (input: ProviderInput) => {
    if (editing?.kind !== "provider") return;
    if (editing.provider) updateProvider.mutate({ id: editing.provider.id, data: input }, { onSuccess: close });
    else createProvider.mutate(input, { onSuccess: close });
  };
  const saveModel = (input: ModelInput) => {
    if (editing?.kind !== "model") return;
    if (editing.model) updateModel.mutate({ id: editing.model.id, data: input }, { onSuccess: close });
    else createModel.mutate(input, { onSuccess: close });
  };

  const test = async (model: ModelEntry) => {
    setTests((current) => ({ ...current, [model.id]: "running" }));
    try {
      const result = await call("settings.models.test", { id: model.id });
      setTests((current) => ({ ...current, [model.id]: result }));
      void models.refetch();
    } catch (error) {
      setTests((current) => ({
        ...current,
        [model.id]: {
          ok: false,
          latencyMs: 0,
          detectedMode: null,
          error: { kind: "internal", message: errorMessage(error) },
        },
      }));
    }
  };

  const roleValue = (id: number | null) => (id === null ? "" : String(id));
  const parseRole = (value: string) => (value === "" ? null : Number(value));
  const roleOptions = modelList.map((model) => (
    <option key={model.id} value={model.id}>
      {model.name}
      {model.callable ? "" : ` ${t("settings.models.notCallable")}`}
    </option>
  ));

  return (
    <div className="flex flex-col gap-8">
      <p className="text-sm text-muted">{t("settings.models.intro")}</p>

      <section className="grid grid-cols-2 gap-4 rounded-lg border border-border bg-panel p-4">
        <h2 className="col-span-2 text-sm font-semibold">{t("settings.models.roles")}</h2>
        <Field label={t("settings.models.routerRole")} htmlFor="role-router" hint={t("settings.models.routerHint")}>
          <Select
            id="role-router"
            value={roleValue(roles.data?.router ?? null)}
            onChange={(event) =>
              setRoles.mutate({ router: parseRole(event.target.value), planner: roles.data?.planner ?? null })
            }
          >
            <option value="">{t("settings.models.unassigned")}</option>
            {roleOptions}
          </Select>
        </Field>
        <Field label={t("settings.models.plannerRole")} htmlFor="role-planner" hint={t("settings.models.plannerHint")}>
          <Select
            id="role-planner"
            value={roleValue(roles.data?.planner ?? null)}
            onChange={(event) =>
              setRoles.mutate({ router: roles.data?.router ?? null, planner: parseRole(event.target.value) })
            }
          >
            <option value="">{t("settings.models.sameAsRouter")}</option>
            {roleOptions}
          </Select>
        </Field>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("settings.tabs.models")}</h2>
          <Button variant="primary" size="sm" onClick={() => setEditing({ kind: "provider", provider: null })}>
            <Plus />
            {t("settings.models.addProvider")}
          </Button>
        </div>
        {providerList.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
            {t("settings.models.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {providerList.map((provider) => (
              <li
                key={provider.id}
                aria-label={provider.name}
                className="flex flex-col gap-3 rounded-lg border border-border bg-panel p-4"
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="font-medium">{provider.name}</h3>
                    <p className="mt-0.5 truncate text-xs text-muted">
                      {t(`settings.providerForm.kinds.${provider.kind}`)}
                      {provider.baseUrl ? ` · ${provider.baseUrl}` : ""} ·{" "}
                      {provider.hasApiKey ? provider.apiKeyHint : t("settings.models.noKey")} ·{" "}
                      {billingSummary(provider.billing, t)}
                    </p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      size="sm"
                      onClick={() => setEditing({ kind: "model", model: null, providerId: provider.id })}
                    >
                      <Plus />
                      {t("settings.models.addModel")}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`${t("settings.models.edit")} ${provider.name}`}
                      onClick={() => setEditing({ kind: "provider", provider })}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`${t("settings.models.delete")} ${provider.name}`}
                      onClick={() => setDeleting({ kind: "provider", provider })}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                {modelList.filter((model) => model.providerId === provider.id).length === 0 ? (
                  <p className="text-sm text-muted">{t("settings.models.noModels")}</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
                    {modelList
                      .filter((model) => model.providerId === provider.id)
                      .map((model) => (
                        <ModelRow
                          key={model.id}
                          model={model}
                          result={tests[model.id]}
                          onTest={() => void test(model)}
                          onEdit={() => setEditing({ kind: "model", model, providerId: model.providerId })}
                          onDelete={() => setDeleting({ kind: "model", model })}
                        />
                      ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => !open && close()}
        title={
          editing?.kind === "provider"
            ? t(editing.provider ? "settings.providerForm.editTitle" : "settings.providerForm.createTitle")
            : t(editing?.model ? "settings.form.editTitle" : "settings.form.createTitle")
        }
        wide
      >
        {editing?.kind === "provider" ? (
          <ProviderForm
            key={editing.provider?.id ?? "new"}
            provider={editing.provider}
            submitting={saving}
            error={saveError ? errorMessage(saveError) : null}
            onSubmit={saveProvider}
            onCancel={close}
          />
        ) : editing?.kind === "model" ? (
          <ModelForm
            key={editing.model?.id ?? `new-${editing.providerId}`}
            model={editing.model}
            providers={providerList}
            providerId={editing.providerId}
            submitting={saving}
            error={saveError ? errorMessage(saveError) : null}
            onSubmit={saveModel}
            onCancel={close}
          />
        ) : null}
      </Dialog>

      <ConfirmDialog
        open={deleting !== null}
        title={t(
          deleting?.kind === "provider" ? "settings.models.deleteProviderTitle" : "settings.models.deleteModelTitle",
        )}
        description={t(
          deleting?.kind === "provider" ? "settings.models.deleteProviderBody" : "settings.models.deleteModelBody",
          { name: deleting?.kind === "provider" ? deleting.provider.name : (deleting?.model.name ?? "") },
        )}
        confirmLabel={t("settings.models.confirmDelete")}
        cancelLabel={t("settings.models.cancel")}
        danger
        onCancel={() => setDeleting(null)}
        onConfirm={() => {
          const done = { onSuccess: () => setDeleting(null) };
          if (deleting?.kind === "provider") deleteProvider.mutate({ id: deleting.provider.id }, done);
          else if (deleting?.kind === "model") deleteModel.mutate({ id: deleting.model.id }, done);
        }}
      />
    </div>
  );
}

function ModelRow({
  model,
  result,
  onTest,
  onEdit,
  onDelete,
}: {
  model: ModelEntry;
  result: ConnectionTestResult | "running" | undefined;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  const price = model.effective;
  const priceText =
    price.mode === "subscription"
      ? t("settings.models.inPlan")
      : price.mode === "free"
        ? t("settings.models.free")
        : price.input === null || price.output === null
          ? t("settings.models.priceUnknown")
          : `${t(price.mode === "relay" ? "settings.models.priceRelay" : "settings.models.price", {
              input: price.input,
              output: price.output,
            })}${price.source === "registry" || price.source === "model" ? ` · ${t(`settings.models.priceSource.${price.source}`)}` : ""}`;
  return (
    <li aria-label={model.name} className="flex flex-col gap-1.5 px-3 py-2.5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">
            {model.name}
            {model.name !== model.modelId ? <span className="ml-2 font-normal text-muted">{model.modelId}</span> : null}
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
            {model.canonicalId ? (
              <span>
                {t(model.canonicalSource === "manual" ? "settings.models.matchedManual" : "settings.models.matched", {
                  name: model.canonicalId,
                })}
              </span>
            ) : (
              <span className="flex items-center gap-1 text-warning">
                <AlertTriangle className="size-3" />
                {t(model.matchProblem === "ambiguous" ? "settings.models.ambiguous" : "settings.models.unmatched")}
              </span>
            )}
            {model.contextWindow ? (
              <span>
                · {t("settings.models.context", { value: model.contextWindow.toLocaleString(i18n.language) })}
              </span>
            ) : null}
            <span>· {priceText}</span>
          </div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Button size="sm" variant="ghost" onClick={onTest} disabled={result === "running" || !model.callable}>
            <Plug />
            {result === "running" ? t("settings.models.testing") : t("settings.models.test")}
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`${t("settings.models.edit")} ${model.name}`}
            onClick={onEdit}
          >
            <Pencil />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            aria-label={`${t("settings.models.delete")} ${model.name}`}
            onClick={onDelete}
          >
            <Trash2 />
          </Button>
        </div>
      </div>
      {result && result !== "running" ? (
        <p className={`text-xs ${result.ok ? "text-success" : "text-danger"}`}>
          {result.ok
            ? t("settings.models.testOk", {
                ms: result.latencyMs,
                mode: result.detectedMode ? t(`settings.form.modes.${result.detectedMode}`) : "",
              })
            : t("settings.models.testFailed", { message: result.error?.message ?? "" })}
        </p>
      ) : null}
    </li>
  );
}
