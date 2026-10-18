import type { ConnectionTestResult, LlmProfile, LlmProfileInput } from "@km0/shared";
import { Pencil, Plug, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select } from "@/components/ui/field";
import { call, errorMessage } from "@/lib/ipc";
import { useIpcMutation, useIpcQuery } from "@/lib/queries";
import { ProfileForm } from "./ProfileForm";

type Editing = { mode: "create" } | { mode: "edit"; profile: LlmProfile } | null;

export function ModelsTab() {
  const { t } = useTranslation();
  const profiles = useIpcQuery("settings.profiles.list");
  const roles = useIpcQuery("settings.roles.get");
  const refresh: Parameters<typeof useIpcMutation>[1] = ["settings.profiles.list", "settings.roles.get"];
  const create = useIpcMutation("settings.profiles.create", refresh);
  const update = useIpcMutation("settings.profiles.update", refresh);
  const remove = useIpcMutation("settings.profiles.delete", refresh);
  const setRoles = useIpcMutation("settings.roles.set", ["settings.roles.get"]);

  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<LlmProfile | null>(null);
  const [tests, setTests] = useState<Record<number, ConnectionTestResult | "running">>({});

  const saving = create.isPending || update.isPending;
  const saveError = create.error ?? update.error;

  const save = (input: LlmProfileInput) => {
    const done = { onSuccess: () => setEditing(null) };
    if (editing?.mode === "edit") update.mutate({ id: editing.profile.id, data: input }, done);
    else create.mutate(input, done);
  };

  const test = async (profile: LlmProfile) => {
    setTests((current) => ({ ...current, [profile.id]: "running" }));
    try {
      const result = await call("settings.profiles.test", { id: profile.id });
      setTests((current) => ({ ...current, [profile.id]: result }));
      void profiles.refetch();
    } catch (error) {
      setTests((current) => ({
        ...current,
        [profile.id]: {
          ok: false,
          latencyMs: 0,
          detectedMode: null,
          error: { kind: "internal", message: errorMessage(error) },
        },
      }));
    }
  };

  const list = profiles.data ?? [];
  const roleValue = (id: number | null) => (id === null ? "" : String(id));
  const parseRole = (value: string) => (value === "" ? null : Number(value));

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
            {list.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
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
            {list.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name}
              </option>
            ))}
          </Select>
        </Field>
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">{t("settings.tabs.models")}</h2>
          <Button variant="primary" size="sm" onClick={() => setEditing({ mode: "create" })}>
            <Plus />
            {t("settings.models.add")}
          </Button>
        </div>
        {list.length === 0 ? (
          <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
            {t("settings.models.empty")}
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {list.map((profile) => {
              const result = tests[profile.id];
              return (
                <li key={profile.id} className="rounded-lg border border-border bg-panel p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="font-medium">{profile.name}</div>
                      <div className="mt-0.5 truncate text-xs text-muted">
                        {profile.provider === "anthropic"
                          ? t("settings.form.providerAnthropic")
                          : t("settings.form.providerOpenai")}{" "}
                        · {profile.model}
                        {profile.baseUrl ? ` · ${profile.baseUrl}` : ""}
                      </div>
                      <div className="mt-1 text-xs text-muted">
                        {profile.hasApiKey ? profile.apiKeyHint : t("settings.models.noKey")} ·{" "}
                        {t(`settings.form.modes.${profile.structuredMode}`)}
                      </div>
                    </div>
                    <div className="flex shrink-0 gap-1">
                      <Button size="sm" onClick={() => void test(profile)} disabled={result === "running"}>
                        <Plug />
                        {result === "running" ? t("settings.models.testing") : t("settings.models.test")}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("settings.models.edit")}
                        onClick={() => setEditing({ mode: "edit", profile })}
                      >
                        <Pencil />
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={t("settings.models.delete")}
                        onClick={() => setDeleting(profile)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  {result && result !== "running" ? (
                    <p className={`mt-3 text-xs ${result.ok ? "text-success" : "text-danger"}`}>
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
            })}
          </ul>
        )}
      </section>

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing?.mode === "edit" ? t("settings.form.editTitle") : t("settings.form.createTitle")}
        wide
      >
        {editing ? (
          <ProfileForm
            key={editing.mode === "edit" ? editing.profile.id : "new"}
            profile={editing.mode === "edit" ? editing.profile : null}
            submitting={saving}
            error={saveError ? errorMessage(saveError) : null}
            onSubmit={save}
            onCancel={() => setEditing(null)}
          />
        ) : null}
      </Dialog>

      <Dialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        title={t("settings.models.deleteTitle")}
        description={t("settings.models.deleteBody", { name: deleting?.name ?? "" })}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{t("settings.models.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleting) remove.mutate({ id: deleting.id }, { onSuccess: () => setDeleting(null) });
              }}
            >
              {t("settings.models.confirmDelete")}
            </Button>
          </>
        }
      />
    </div>
  );
}
