import type { SearchService, SearchServiceInput, SearchServiceKind, SearchTestResult } from "@km0/shared";
import { Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/field";
import { call, errorMessage } from "@/lib/ipc";
import { useIpcMutation, useIpcQuery } from "@/lib/queries";

type Editing = { mode: "create" } | { mode: "edit"; service: SearchService } | null;

/** Search services used to check technology choices before the stage C questions. */
export function SearchTab() {
  const { t } = useTranslation();
  const services = useIpcQuery("settings.search.list");
  const info = useIpcQuery("app.info");
  const create = useIpcMutation("settings.search.create", ["settings.search.list"]);
  const update = useIpcMutation("settings.search.update", ["settings.search.list"]);
  const remove = useIpcMutation("settings.search.delete", ["settings.search.list"]);
  const [editing, setEditing] = useState<Editing>(null);
  const [deleting, setDeleting] = useState<SearchService | null>(null);
  const [tests, setTests] = useState<Record<number, SearchTestResult | "running">>({});
  const web = info.data?.platform === "web";
  const list = services.data ?? [];
  const activeId = list.find((service) => service.enabled && !(web && service.config.kind === "mcp_stdio"))?.id;
  const saveError = create.error ?? update.error;

  const save = (input: SearchServiceInput) => {
    const done = { onSuccess: () => setEditing(null) };
    if (editing?.mode === "edit") update.mutate({ id: editing.service.id, data: input }, done);
    else create.mutate(input, done);
  };

  const test = async (service: SearchService) => {
    setTests((current) => ({ ...current, [service.id]: "running" }));
    try {
      const result = await call("settings.search.test", { id: service.id, query: t("settings.search.testQuery") });
      setTests((current) => ({ ...current, [service.id]: result }));
    } catch (error) {
      setTests((current) => ({
        ...current,
        [service.id]: { ok: false, latencyMs: 0, results: [], error: errorMessage(error) },
      }));
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">{t("settings.search.intro")}</p>
      <div className="flex justify-end">
        <Button variant="primary" size="sm" onClick={() => setEditing({ mode: "create" })}>
          <Plus />
          {t("settings.search.add")}
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted">
          {t("settings.search.empty")}
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {list.map((service) => {
            const result = tests[service.id];
            const config = service.config;
            return (
              <li key={service.id} className="rounded-lg border border-border bg-panel p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 font-medium">
                      {service.name}
                      {service.id === activeId ? (
                        <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[11px] font-normal text-accent">
                          {t("settings.search.active")}
                        </span>
                      ) : !service.enabled ? (
                        <span className="rounded bg-sunken px-1.5 py-0.5 text-[11px] font-normal text-muted">
                          {t("settings.search.disabled")}
                        </span>
                      ) : null}
                    </div>
                    <div className="mt-0.5 truncate text-xs text-muted">
                      {t(`settings.search.kinds.${config.kind}`)}
                      {config.kind === "mcp_stdio"
                        ? ` · ${[config.command, ...config.args].join(" ")} · ${config.toolName}`
                        : config.kind === "mcp_http"
                          ? ` · ${config.url} · ${config.toolName}`
                          : ""}
                    </div>
                    <div className="mt-1 text-xs text-muted">
                      {service.hasSecret ? service.secretHint : t("settings.search.noSecret")}
                    </div>
                    {web && config.kind === "mcp_stdio" ? (
                      <p className="mt-1 text-xs text-warning">{t("settings.search.webNoStdio")}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="sm" onClick={() => void test(service)} disabled={result === "running"}>
                      <Search />
                      {result === "running" ? t("settings.search.testing") : t("settings.search.test")}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("settings.search.edit")}
                      onClick={() => setEditing({ mode: "edit", service })}
                    >
                      <Pencil />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={t("settings.search.delete")}
                      onClick={() => setDeleting(service)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                {result && result !== "running" ? (
                  <div className={`mt-3 text-xs ${result.ok ? "text-success" : "text-danger"}`}>
                    {result.ok
                      ? t("settings.search.testOk", { count: result.results.length, ms: result.latencyMs })
                      : t("settings.search.testFailed", { message: result.error ?? "" })}
                    {result.ok && result.results.length > 0 ? (
                      <ul className="mt-1 list-disc pl-4 text-muted">
                        {result.results.slice(0, 3).map((item) => (
                          <li key={item.url || item.title} className="truncate">
                            {item.title}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <Dialog
        open={editing !== null}
        onOpenChange={(open) => {
          if (!open) setEditing(null);
        }}
        title={editing?.mode === "edit" ? t("settings.search.form.editTitle") : t("settings.search.form.createTitle")}
        wide
      >
        {editing ? (
          <SearchServiceForm
            key={editing.mode === "edit" ? editing.service.id : "new"}
            service={editing.mode === "edit" ? editing.service : null}
            web={web}
            submitting={create.isPending || update.isPending}
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
        title={t("settings.search.deleteTitle")}
        description={t("settings.search.deleteBody", { name: deleting?.name ?? "" })}
        footer={
          <>
            <Button onClick={() => setDeleting(null)}>{t("settings.search.cancel")}</Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleting) remove.mutate({ id: deleting.id }, { onSuccess: () => setDeleting(null) });
              }}
            >
              {t("settings.search.confirmDelete")}
            </Button>
          </>
        }
      />
    </div>
  );
}

interface FormProps {
  service: SearchService | null;
  web: boolean;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: SearchServiceInput) => void;
  onCancel: () => void;
}

export function SearchServiceForm({ service, web, submitting, error, onSubmit, onCancel }: FormProps) {
  const { t } = useTranslation();
  const config = service?.config;
  const [name, setName] = useState(service?.name ?? "");
  const [kind, setKind] = useState<SearchServiceKind>(config?.kind ?? "bocha");
  const [enabled, setEnabled] = useState(service?.enabled ?? true);
  const [command, setCommand] = useState(config?.kind === "mcp_stdio" ? config.command : "");
  const [args, setArgs] = useState(config?.kind === "mcp_stdio" ? config.args.join("\n") : "");
  const [url, setUrl] = useState(config?.kind === "mcp_http" ? config.url : "");
  const [toolName, setToolName] = useState(config && config.kind !== "bocha" ? config.toolName : "");
  const [queryArg, setQueryArg] = useState(config && config.kind !== "bocha" ? config.queryArg : "query");
  const [secret, setSecret] = useState("");
  const [touched, setTouched] = useState(false);

  const missing =
    !name.trim() ||
    (kind === "bocha" && !service?.hasSecret && !secret.trim()) ||
    (kind === "mcp_stdio" && !command.trim()) ||
    (kind === "mcp_http" && !/^https?:\/\/\S+$/.test(url.trim())) ||
    (kind !== "bocha" && (!toolName.trim() || !queryArg.trim()));

  const submit = () => {
    setTouched(true);
    if (missing) return;
    const mcp = { toolName: toolName.trim(), queryArg: queryArg.trim() };
    const built =
      kind === "bocha"
        ? { kind }
        : kind === "mcp_stdio"
          ? {
              kind,
              command: command.trim(),
              args: args
                .split("\n")
                .map((line) => line.trim())
                .filter(Boolean),
              ...mcp,
            }
          : { kind, url: url.trim(), ...mcp };
    // An empty field keeps the stored secret when editing.
    const keepSecret = service?.hasSecret && !secret.trim() && service.config.kind === kind;
    onSubmit({
      name: name.trim(),
      enabled,
      config: built,
      ...(keepSecret ? {} : { secret: secret.trim() }),
    });
  };
  const required = (value: boolean) => (touched && value ? t("settings.search.form.required") : undefined);
  const secretPlaceholder = service?.hasSecret ? t("settings.search.form.keepSecret") : "";

  return (
    <form
      className="grid gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="grid grid-cols-2 gap-4">
        <Field label={t("settings.search.form.name")} htmlFor="search-name" error={required(!name.trim())}>
          <Input id="search-name" value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t("settings.search.form.kind")} htmlFor="search-kind">
          <Select id="search-kind" value={kind} onChange={(event) => setKind(event.target.value as SearchServiceKind)}>
            {(["bocha", "mcp_http", "mcp_stdio"] as const).map((item) => (
              <option key={item} value={item} disabled={web && item === "mcp_stdio"}>
                {t(`settings.search.kinds.${item}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {kind === "bocha" ? (
        <Field
          label={t("settings.search.form.apiKey")}
          htmlFor="search-key"
          hint={t("settings.search.form.apiKeyHint")}
          error={required(!service?.hasSecret && !secret.trim())}
        >
          <Input
            id="search-key"
            type="password"
            autoComplete="off"
            placeholder={secretPlaceholder}
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
          />
        </Field>
      ) : (
        <>
          {kind === "mcp_stdio" ? (
            <div className="grid grid-cols-2 gap-4">
              <Field
                label={t("settings.search.form.command")}
                htmlFor="search-command"
                hint={t("settings.search.form.commandHint")}
                error={required(!command.trim())}
              >
                <Input id="search-command" value={command} onChange={(event) => setCommand(event.target.value)} />
              </Field>
              <Field
                label={t("settings.search.form.args")}
                htmlFor="search-args"
                hint={t("settings.search.form.argsHint")}
              >
                <Textarea
                  id="search-args"
                  className="min-h-16"
                  rows={2}
                  value={args}
                  onChange={(event) => setArgs(event.target.value)}
                />
              </Field>
            </div>
          ) : (
            <Field
              label={t("settings.search.form.url")}
              htmlFor="search-url"
              error={required(!/^https?:\/\/\S+$/.test(url.trim()))}
            >
              <Input
                id="search-url"
                placeholder="https://"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-4">
            <Field
              label={t("settings.search.form.toolName")}
              htmlFor="search-tool"
              hint={t("settings.search.form.toolNameHint")}
              error={required(!toolName.trim())}
            >
              <Input id="search-tool" value={toolName} onChange={(event) => setToolName(event.target.value)} />
            </Field>
            <Field label={t("settings.search.form.queryArg")} htmlFor="search-arg" error={required(!queryArg.trim())}>
              <Input id="search-arg" value={queryArg} onChange={(event) => setQueryArg(event.target.value)} />
            </Field>
          </div>
          <Field
            label={kind === "mcp_stdio" ? t("settings.search.form.env") : t("settings.search.form.headers")}
            htmlFor="search-secret"
            hint={kind === "mcp_stdio" ? t("settings.search.form.envHint") : t("settings.search.form.headersHint")}
          >
            <Textarea
              id="search-secret"
              className="min-h-16 font-mono"
              rows={2}
              placeholder={secretPlaceholder}
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
            />
          </Field>
        </>
      )}

      <label className="flex w-fit items-center gap-2 text-sm">
        <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
        {t("settings.search.form.enabled")}
      </label>

      {error ? <p className="text-sm text-danger">{error}</p> : null}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>{t("settings.search.form.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={submitting}>
          {t("settings.search.form.save")}
        </Button>
      </div>
    </form>
  );
}
