import { zodResolver } from "@hookform/resolvers/zod";
import type { ModelEntry, ModelInput, Provider } from "@km0/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { call } from "@/lib/ipc";

const optionalNumber = z
  .string()
  .trim()
  .refine((value) => value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0), "invalidNumber");

const FormSchema = z.object({
  providerId: z.string().min(1, "required"),
  modelId: z.string().trim().min(1, "required"),
  name: z.string().trim(),
  contextWindow: optionalNumber,
  structuredMode: z.enum(["auto", "json_schema", "tool", "prompt"]),
  temperature: optionalNumber,
  priceIn: optionalNumber,
  priceOut: optionalNumber,
  priceCacheRead: optionalNumber,
});
type FormValues = z.infer<typeof FormSchema>;

const toNumber = (value: string): number | null => (value.trim() === "" ? null : Number(value));
const text = (value: number | null) => value?.toString() ?? "";

interface ModelFormProps {
  model: ModelEntry | null;
  providers: Provider[];
  providerId: number | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: ModelInput) => void;
  onCancel: () => void;
}

/** A model under a provider: its ID, which leaderboard model it is, and price overrides. */
export function ModelForm({ model, providers, providerId, submitting, error, onSubmit, onCancel }: ModelFormProps) {
  const { t } = useTranslation();
  const form = useForm<FormValues>({
    resolver: zodResolver(FormSchema),
    defaultValues: {
      providerId: String(model?.providerId ?? providerId ?? providers[0]?.id ?? ""),
      modelId: model?.modelId ?? "",
      name: model && model.name !== model.modelId ? model.name : "",
      contextWindow: text(model?.contextWindowOverride ?? null),
      structuredMode: model?.structuredMode ?? "auto",
      temperature: text(model?.temperature ?? null),
      priceIn: text(model?.priceInPerMTok ?? null),
      priceOut: text(model?.priceOutPerMTok ?? null),
      priceCacheRead: text(model?.priceCacheReadPerMTok ?? null),
    },
  });
  const { register, handleSubmit, formState } = form;
  // null: match by the model ID; a registry ID: chosen by hand.
  const [canonical, setCanonical] = useState<string | null>(
    model?.canonicalSource === "manual" ? model.canonicalId : null,
  );
  const [query, setQuery] = useState("");
  const choices = useQuery({
    queryKey: ["settings.models.registryChoices", query],
    queryFn: () => call("settings.models.registryChoices", { query }),
    enabled: query.trim().length >= 2,
  });

  const fieldError = (name: keyof FormValues) => {
    const message = formState.errors[name]?.message;
    return message ? t(`settings.form.${message}` as "settings.form.required") : undefined;
  };

  const submit = handleSubmit((values) =>
    onSubmit({
      providerId: Number(values.providerId),
      modelId: values.modelId,
      name: values.name,
      canonicalId: canonical,
      contextWindow: toNumber(values.contextWindow),
      structuredMode: values.structuredMode,
      temperature: toNumber(values.temperature),
      priceInPerMTok: toNumber(values.priceIn),
      priceOutPerMTok: toNumber(values.priceOut),
      priceCacheReadPerMTok: toNumber(values.priceCacheRead),
    }),
  );

  return (
    <form id="model-form" onSubmit={submit} className="grid grid-cols-2 gap-4">
      <Field label={t("settings.form.provider")} htmlFor="providerId" className="col-span-2">
        <Select id="providerId" {...register("providerId")}>
          {providers.map((provider) => (
            <option key={provider.id} value={provider.id}>
              {provider.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label={t("settings.form.model")}
        htmlFor="modelId"
        hint={t("settings.form.modelHint")}
        error={fieldError("modelId")}
      >
        <Input id="modelId" spellCheck={false} {...register("modelId")} />
      </Field>
      <Field label={t("settings.form.name")} htmlFor="name">
        <Input id="name" {...register("name")} />
      </Field>

      <fieldset className="col-span-2 flex flex-col gap-2">
        <legend className="mb-1.5 text-xs font-medium text-muted">{t("settings.form.match")}</legend>
        <label className="flex items-center gap-2 text-sm">
          <input type="radio" checked={canonical === null} onChange={() => setCanonical(null)} />
          {t("settings.form.matchAuto")}
          {model && model.canonicalSource === "auto" && canonical === null ? (
            <span className="text-muted">· {model.canonicalId}</span>
          ) : null}
        </label>
        {canonical ? (
          <label className="flex items-center gap-2 text-sm">
            <input type="radio" checked readOnly />
            <span className="font-medium">{canonical}</span>
          </label>
        ) : null}
        <Input
          aria-label={t("settings.form.matchSearch")}
          placeholder={t("settings.form.matchSearch")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query.trim().length >= 2 ? (
          <ul
            aria-label={t("settings.form.matchSearch")}
            className="max-h-40 overflow-y-auto rounded-md border border-border"
          >
            {(choices.data ?? []).length === 0 ? (
              <li className="px-3 py-1.5 text-sm text-muted">{t("settings.form.matchNone")}</li>
            ) : (
              (choices.data ?? []).map((choice) => (
                <li key={choice.id}>
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-sm hover:bg-sunken",
                      canonical === choice.id && "bg-accent/10 font-medium",
                    )}
                    onClick={() => {
                      setCanonical(choice.id);
                      setQuery("");
                    }}
                  >
                    <span className="truncate">{choice.name}</span>
                    <span className="shrink-0 text-xs text-muted">{choice.id}</span>
                  </button>
                </li>
              ))
            )}
          </ul>
        ) : null}
      </fieldset>

      <Field label={t("settings.form.structuredMode")} htmlFor="structuredMode">
        <Select id="structuredMode" {...register("structuredMode")}>
          {(["auto", "json_schema", "tool", "prompt"] as const).map((mode) => (
            <option key={mode} value={mode}>
              {t(`settings.form.modes.${mode}`)}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("settings.form.temperature")} htmlFor="temperature" error={fieldError("temperature")}>
        <Input id="temperature" inputMode="decimal" {...register("temperature")} />
      </Field>
      <Field
        label={t("settings.form.contextWindow")}
        htmlFor="contextWindow"
        error={fieldError("contextWindow")}
        className="col-span-2"
      >
        <Input id="contextWindow" inputMode="numeric" {...register("contextWindow")} />
      </Field>
      <p className="col-span-2 -mb-2 text-xs text-muted">{t("settings.form.priceHint")}</p>
      <div className="col-span-2 grid grid-cols-3 gap-4">
        <Field label={t("settings.form.priceIn")} htmlFor="priceIn" error={fieldError("priceIn")}>
          <Input id="priceIn" inputMode="decimal" {...register("priceIn")} />
        </Field>
        <Field label={t("settings.form.priceOut")} htmlFor="priceOut" error={fieldError("priceOut")}>
          <Input id="priceOut" inputMode="decimal" {...register("priceOut")} />
        </Field>
        <Field label={t("settings.form.priceCacheRead")} htmlFor="priceCacheRead" error={fieldError("priceCacheRead")}>
          <Input id="priceCacheRead" inputMode="decimal" {...register("priceCacheRead")} />
        </Field>
      </div>
      {error ? <p className="col-span-2 text-sm text-danger">{error}</p> : null}
      <div className="col-span-2 flex justify-end gap-2">
        <Button onClick={onCancel}>{t("settings.form.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={submitting}>
          {t("settings.form.save")}
        </Button>
      </div>
    </form>
  );
}
