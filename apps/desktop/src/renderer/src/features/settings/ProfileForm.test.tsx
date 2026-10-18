import type { LlmProfile } from "@km0/shared";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import "@/i18n";
import { ProfileForm } from "./ProfileForm";

function setup(profile: LlmProfile | null = null) {
  const onSubmit = vi.fn();
  render(<ProfileForm profile={profile} submitting={false} error={null} onSubmit={onSubmit} onCancel={() => {}} />);
  return { onSubmit, user: userEvent.setup() };
}

const saved: LlmProfile = {
  id: 3,
  name: "Qwen",
  provider: "openai",
  baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
  model: "qwen-plus",
  structuredMode: "tool",
  temperature: null,
  priceInPerMTok: 0.4,
  priceOutPerMTok: 1.2,
  hasApiKey: true,
  apiKeyHint: "••••9f2c",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("ProfileForm", () => {
  it("fills a new profile from the preset and converts empty fields", async () => {
    const { onSubmit, user } = setup();
    await user.type(screen.getByLabelText(/API Key/i), " sk-new ");
    await user.click(screen.getByRole("button", { name: /保存|Save/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      name: "DeepSeek",
      provider: "openai",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: "sk-new",
      structuredMode: "auto",
      temperature: null,
      priceInPerMTok: null,
      priceOutPerMTok: null,
    });
  });

  it("switches the base URL when the compatibility format changes", async () => {
    const { user } = setup();
    await user.selectOptions(screen.getByLabelText(/兼容格式|Compatibility/), "anthropic");
    expect(screen.getByLabelText("Base URL")).toHaveValue("https://api.deepseek.com/anthropic");
  });

  it("keeps the stored key unless the user types or clears one", async () => {
    const { onSubmit, user } = setup(saved);
    expect(screen.getByText(/••••9f2c/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /保存|Save/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("apiKey");
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ priceInPerMTok: 0.4, structuredMode: "tool" });

    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /保存|Save/ }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    expect(onSubmit.mock.calls[1]?.[0]).toMatchObject({ apiKey: "" });
  });

  it("rejects an invalid URL and a missing model", async () => {
    const { onSubmit, user } = setup();
    const url = screen.getByLabelText("Base URL");
    await user.clear(url);
    await user.type(url, "not a url");
    await user.clear(screen.getByLabelText(/模型 ID|Model ID/));
    await user.click(screen.getByRole("button", { name: /保存|Save/ }));
    expect(await screen.findByText(/有效的 URL|valid URL/)).toBeInTheDocument();
    expect(screen.getByText(/必填|Required/)).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
