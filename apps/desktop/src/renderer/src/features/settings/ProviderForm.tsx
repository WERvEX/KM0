import { zodResolver } from "@hookform/resolvers/zod";
import { type Billing, PROVIDER_PRESETS, type Provider, type ProviderInput, type ProviderKind } from "@km0/shared";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";

const optionalNumber = z
  .string()
  .trim()
  .refine((value) => value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0), "invalidNumber");

const FormSchema = z
  .object({
    preset: z.string(),
    name: z.string().trim().min(1, "required"),
    kind: z.enum(["openai", "anthropic"]),
    baseUrl: z
      .string()
      .trim()
      .refine((value) => value === "" || URL.canParse(value), "invalidUrl"),
    apiKey: z.string(),
    mode: z.enum(["token", "relay", "subscription", "free"]),
    multiplier: optionalNumber,
    monthlyFee: optionalNumber,
    quotaAmount: optionalNumber,
    quotaUnit: z.enum(["requests", "tokens", "usd"]),
    quotaWindow: z.enum(["5h", "day", "week", "month"]),
    overflow: z.enum(["token", "unavailable"]),
  })
  .refine((values) => values.mode !== "relay" || Number(values.multiplier) > 0, {
    path: ["multiplier"],
    message: "invalidNumber",
  });
type FormValues = z.infer<typeof FormSchema>;

/** Stands in for a saved key in the password field; it is never sent to the main process. */
const SAVED_KEY = "••••••••••••";

const toNumber = (value: string): number | null => (value.trim() === "" ? null : Number(value));

function initialValues(provider: Provider | null): FormValues {
  const billing = provider?.billing ?? { mode: "token" };
  const subscription = billing.mode === "subscription" ? billing : null;
  const base = {
    mode: billing.mode,
    multiplier: billing.mode === "relay" ? String(billing.multiplier) : "1",
    monthlyFee: subscription?.monthlyFee?.toString() ?? "",
    quotaAmount: subscription?.quota?.amount.toString() ?? "",
    quotaUnit: subscription?.quota?.unit ?? "requests",
    quotaWindow: subscription?.quota?.window ?? "5h",
    overflow: subscription?.overflow ?? "unavailable",
  } as const;
  if (provider) {
    const preset = PROVIDER_PRESETS.find((item) => item.urls[provider.kind] === provider.baseUrl);
    return {
      ...base,
      preset: preset?.id ?? "custom",
      name: provider.name,
      kind: provider.kind,
      baseUrl: provider.baseUrl ?? "",
      // The saved key never reaches the renderer; a placeholder shows as dots until the user edits it.
      apiKey: provider.hasApiKey ? SAVED_KEY : "",
    };
  }
  const preset = PROVIDER_PRESETS.find((item) => item.id === "deepseek");
  return {
    ...base,
    preset: "deepseek",
    name: preset?.label ?? "",
    kind: preset?.defaultProvider ?? "openai",
    baseUrl: preset?.urls.openai ?? "",
    apiKey: "",
  };
}

function toBilling(values: FormValues): Billing {
  switch (values.mode) {
    case "relay":
      return { mode: "relay", multiplier: Number(values.multiplier) };
    case "subscription": {
      const amount = toNumber(values.quotaAmount);
      return {
        mode: "subscription",
        monthlyFee: toNumber(values.monthlyFee),
        quota: amount ? { amount, unit: values.quotaUnit, window: values.quotaWindow } : null,
        overflow: values.overflow,
      };
    }
    default:
      return { mode: values.mode };
  }
}

interface ProviderFormProps {
  provider: Provider | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: ProviderInput) => void;
  onCancel: () => void;
}

/** A provider: its endpoint and key, and how it charges. */
export function ProviderForm({ provider, submitting, error, onSubmit, onCancel }: ProviderFormProps) {
  const { t } = useTranslation();
  const form = useForm<FormValues>({ resolver: zodResolver(FormSchema), defaultValues: initialValues(provider) });
  const { register, handleSubmit, setValue, getValues, formState, watch } = form;
  const mode = watch("mode");

  const fieldError = (name: keyof FormValues) => {
    const message = formState.errors[name]?.message;
    return message ? t(`settings.providerForm.${message}` as "settings.providerForm.required") : undefined;
  };

  const applyPreset = (presetId: string) => {
    const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
    if (!preset || preset.id === "custom") return;
    const kind = preset.urls[getValues("kind")] ? getValues("kind") : preset.defaultProvider;
    setValue("kind", kind);
    setValue("baseUrl", preset.urls[kind] ?? "");
    if (!provider) setValue("name", preset.label);
  };

  const applyKind = (kind: ProviderKind) => {
    const preset = PROVIDER_PRESETS.find((item) => item.id === getValues("preset"));
    const url = preset?.urls[kind];
    if (url) setValue("baseUrl", url);
  };

  const submit = handleSubmit((values) => {
    // Unchanged placeholder keeps the saved key, an empty field removes it, anything else replaces it.
    let apiKey: string | undefined;
    if (values.apiKey !== SAVED_KEY) apiKey = values.apiKey.trim() || (provider?.hasApiKey ? "" : undefined);
    onSubmit({
      name: values.name,
      kind: values.kind,
      baseUrl: values.baseUrl.trim() || null,
      ...(apiKey !== undefined ? { apiKey } : {}),
      billing: toBilling(values),
    });
  });

  return (
    <form id="provider-form" onSubmit={submit} className="grid grid-cols-2 gap-4">
      <Field label={t("settings.providerForm.preset")} htmlFor="preset">
        <Select id="preset" {...register("preset", { onChange: (event) => applyPreset(event.target.value) })}>
          {PROVIDER_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("settings.providerForm.kind")} htmlFor="kind">
        <Select id="kind" {...register("kind", { onChange: (event) => applyKind(event.target.value as ProviderKind) })}>
          <option value="openai">{t("settings.providerForm.kinds.openai")}</option>
          <option value="anthropic">{t("settings.providerForm.kinds.anthropic")}</option>
        </Select>
      </Field>
      <Field label={t("settings.providerForm.name")} htmlFor="name" error={fieldError("name")} className="col-span-2">
        <Input id="name" {...register("name")} />
      </Field>
      <Field
        label={t("settings.providerForm.baseUrl")}
        htmlFor="baseUrl"
        hint={t("settings.providerForm.baseUrlHint")}
        error={fieldError("baseUrl")}
        className="col-span-2"
      >
        <Input id="baseUrl" {...register("baseUrl")} />
      </Field>
      <Field label={t("settings.providerForm.apiKey")} htmlFor="apiKey" className="col-span-2">
        <Input
          id="apiKey"
          type="password"
          autoComplete="off"
          {...register("apiKey")}
          onFocus={(event) => {
            // Typing replaces the saved key instead of appending to the placeholder.
            if (event.target.value === SAVED_KEY) event.target.select();
          }}
        />
      </Field>
      <Field label={t("settings.providerForm.billing")} htmlFor="mode" className="col-span-2">
        <Select id="mode" {...register("mode")}>
          {(["token", "relay", "subscription", "free"] as const).map((value) => (
            <option key={value} value={value}>
              {t(`settings.providerForm.modes.${value}`)}
            </option>
          ))}
        </Select>
      </Field>
      {mode === "relay" ? (
        <Field
          label={t("settings.providerForm.multiplier")}
          htmlFor="multiplier"
          hint={t("settings.providerForm.multiplierHint")}
          error={fieldError("multiplier")}
        >
          <Input id="multiplier" inputMode="decimal" {...register("multiplier")} />
        </Field>
      ) : null}
      {mode === "subscription" ? (
        <>
          <Field label={t("settings.providerForm.monthlyFee")} htmlFor="monthlyFee" error={fieldError("monthlyFee")}>
            <Input id="monthlyFee" inputMode="decimal" {...register("monthlyFee")} />
          </Field>
          <Field label={t("settings.providerForm.overflow")} htmlFor="overflow">
            <Select id="overflow" {...register("overflow")}>
              {(["unavailable", "token"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`settings.providerForm.overflows.${value}`)}
                </option>
              ))}
            </Select>
          </Field>
          <fieldset className="col-span-2 grid grid-cols-3 gap-2">
            <legend className="mb-1.5 text-xs font-medium text-muted">{t("settings.providerForm.quota")}</legend>
            <Input
              aria-label={t("settings.providerForm.quotaAmount")}
              placeholder={t("settings.providerForm.quotaAmount")}
              inputMode="decimal"
              {...register("quotaAmount")}
            />
            <Select aria-label={t("settings.providerForm.quota")} {...register("quotaUnit")}>
              {(["requests", "tokens", "usd"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`settings.providerForm.quotaUnit.${value}`)}
                </option>
              ))}
            </Select>
            <Select aria-label={t("settings.providerForm.quotaWindow.5h")} {...register("quotaWindow")}>
              {(["5h", "day", "week", "month"] as const).map((value) => (
                <option key={value} value={value}>
                  {t(`settings.providerForm.quotaWindow.${value}`)}
                </option>
              ))}
            </Select>
          </fieldset>
        </>
      ) : null}
      {error ? <p className="col-span-2 text-sm text-danger">{error}</p> : null}
      <div className="col-span-2 flex justify-end gap-2">
        <Button onClick={onCancel}>{t("settings.providerForm.cancel")}</Button>
        <Button type="submit" variant="primary" disabled={submitting}>
          {t("settings.providerForm.save")}
        </Button>
      </div>
    </form>
  );
}

/** One line describing how a provider charges. */
export function billingSummary(
  billing: Billing,
  t: (key: string, options?: Record<string, unknown>) => string,
): string {
  switch (billing.mode) {
    case "relay":
      return t("settings.providerForm.summary.relay", { multiplier: billing.multiplier });
    case "subscription":
      return billing.monthlyFee
        ? t("settings.providerForm.summary.subscriptionFee", { fee: billing.monthlyFee })
        : t("settings.providerForm.summary.subscription");
    default:
      return t(`settings.providerForm.summary.${billing.mode}`);
  }
}
