import { zodResolver } from "@hookform/resolvers/zod";
import { type LlmProfile, type LlmProfileInput, PROVIDER_PRESETS, type ProviderKind } from "@km0/shared";
import { useForm } from "react-hook-form";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Field, Input, Select } from "@/components/ui/field";

const optionalNumber = z
  .string()
  .trim()
  .refine((value) => value === "" || (Number.isFinite(Number(value)) && Number(value) >= 0), "invalidNumber");

const FormSchema = z.object({
  preset: z.string(),
  name: z.string().trim().min(1, "required"),
  provider: z.enum(["openai", "anthropic"]),
  baseUrl: z
    .string()
    .trim()
    .refine((value) => value === "" || URL.canParse(value), "invalidUrl"),
  model: z.string().trim().min(1, "required"),
  apiKey: z.string(),
  structuredMode: z.enum(["auto", "json_schema", "tool", "prompt"]),
  temperature: optionalNumber,
  priceIn: optionalNumber,
  priceOut: optionalNumber,
});
type FormValues = z.infer<typeof FormSchema>;

/** Stands in for a saved key in the password field; it is never sent to the main process. */
const SAVED_KEY = "••••••••••••";

function toNumber(value: string): number | null {
  return value.trim() === "" ? null : Number(value);
}

function presetFor(profile: LlmProfile | null): string {
  if (!profile) return "deepseek";
  const match = PROVIDER_PRESETS.find((preset) => preset.urls[profile.provider] === profile.baseUrl);
  return match?.id ?? "custom";
}

function initialValues(profile: LlmProfile | null): FormValues {
  if (profile) {
    return {
      preset: presetFor(profile),
      name: profile.name,
      provider: profile.provider,
      baseUrl: profile.baseUrl ?? "",
      model: profile.model,
      // The saved key never reaches the renderer; a placeholder shows as dots until the user edits it.
      apiKey: profile.hasApiKey ? SAVED_KEY : "",
      structuredMode: profile.structuredMode,
      temperature: profile.temperature?.toString() ?? "",
      priceIn: profile.priceInPerMTok?.toString() ?? "",
      priceOut: profile.priceOutPerMTok?.toString() ?? "",
    };
  }
  const preset = PROVIDER_PRESETS.find((item) => item.id === "deepseek");
  return {
    preset: "deepseek",
    name: preset?.label ?? "",
    provider: preset?.defaultProvider ?? "openai",
    baseUrl: preset?.urls.openai ?? "",
    model: preset?.modelHint ?? "",
    apiKey: "",
    structuredMode: "auto",
    temperature: "",
    priceIn: "",
    priceOut: "",
  };
}

interface ProfileFormProps {
  profile: LlmProfile | null;
  submitting: boolean;
  error: string | null;
  onSubmit: (input: LlmProfileInput) => void;
  onCancel: () => void;
}

export function ProfileForm({ profile, submitting, error, onSubmit, onCancel }: ProfileFormProps) {
  const { t } = useTranslation();
  const form = useForm<FormValues>({ resolver: zodResolver(FormSchema), defaultValues: initialValues(profile) });
  const { register, handleSubmit, setValue, getValues, formState } = form;

  const fieldError = (name: keyof FormValues) => {
    const message = formState.errors[name]?.message;
    return message ? t(`settings.form.${message}` as "settings.form.required") : undefined;
  };

  const applyPreset = (presetId: string) => {
    const preset = PROVIDER_PRESETS.find((item) => item.id === presetId);
    if (!preset || preset.id === "custom") return;
    const provider = preset.urls[getValues("provider")] ? getValues("provider") : preset.defaultProvider;
    setValue("provider", provider);
    setValue("baseUrl", preset.urls[provider] ?? "");
    if (!profile) {
      setValue("name", preset.label);
      setValue("model", preset.modelHint);
    }
  };

  const applyProvider = (provider: ProviderKind) => {
    const preset = PROVIDER_PRESETS.find((item) => item.id === getValues("preset"));
    const url = preset?.urls[provider];
    if (url) setValue("baseUrl", url);
  };

  const submit = handleSubmit((values) => {
    // Unchanged placeholder keeps the saved key, an empty field removes it, anything else replaces it.
    let apiKey: string | undefined;
    if (values.apiKey !== SAVED_KEY) apiKey = values.apiKey.trim() || (profile?.hasApiKey ? "" : undefined);
    onSubmit({
      name: values.name,
      provider: values.provider,
      baseUrl: values.baseUrl.trim() || null,
      model: values.model,
      ...(apiKey !== undefined ? { apiKey } : {}),
      structuredMode: values.structuredMode,
      temperature: toNumber(values.temperature),
      priceInPerMTok: toNumber(values.priceIn),
      priceOutPerMTok: toNumber(values.priceOut),
    });
  });

  return (
    <form id="profile-form" onSubmit={submit} className="grid grid-cols-2 gap-4">
      <Field label={t("settings.form.preset")} htmlFor="preset">
        <Select id="preset" {...register("preset", { onChange: (event) => applyPreset(event.target.value) })}>
          {PROVIDER_PRESETS.map((preset) => (
            <option key={preset.id} value={preset.id}>
              {preset.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field label={t("settings.form.provider")} htmlFor="provider">
        <Select
          id="provider"
          {...register("provider", { onChange: (event) => applyProvider(event.target.value as ProviderKind) })}
        >
          <option value="openai">{t("settings.form.providerOpenai")}</option>
          <option value="anthropic">{t("settings.form.providerAnthropic")}</option>
        </Select>
      </Field>
      <Field label={t("settings.form.name")} htmlFor="name" error={fieldError("name")}>
        <Input id="name" {...register("name")} />
      </Field>
      <Field label={t("settings.form.model")} htmlFor="model" error={fieldError("model")}>
        <Input id="model" {...register("model")} />
      </Field>
      <Field
        label={t("settings.form.baseUrl")}
        htmlFor="baseUrl"
        hint={t("settings.form.baseUrlHint")}
        error={fieldError("baseUrl")}
        className="col-span-2"
      >
        <Input id="baseUrl" {...register("baseUrl")} />
      </Field>
      <Field label={t("settings.form.apiKey")} htmlFor="apiKey" className="col-span-2">
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
      <Field label={t("settings.form.structuredMode")} htmlFor="structuredMode" className="col-span-2">
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
      <div />
      <Field label={t("settings.form.priceIn")} htmlFor="priceIn" error={fieldError("priceIn")}>
        <Input id="priceIn" inputMode="decimal" {...register("priceIn")} />
      </Field>
      <Field label={t("settings.form.priceOut")} htmlFor="priceOut" error={fieldError("priceOut")}>
        <Input id="priceOut" inputMode="decimal" {...register("priceOut")} />
      </Field>
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
