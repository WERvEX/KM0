import type { QuestionRound } from "@km0/shared";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import "@/i18n";
import { QuestionRoundCard } from "./QuestionRoundCard";

const round: QuestionRound = {
  id: 7,
  stage: "tech",
  roundNo: 1,
  review: false,
  status: "open",
  questions: [
    {
      id: "r1q1",
      decisionKey: "backend",
      prompt: "后端用什么？",
      type: "single",
      allowCustom: true,
      options: [
        { id: "o1", label: "FastAPI", recommended: true },
        { id: "o2", label: "Express", recommended: false },
      ],
    },
    {
      id: "r1q2",
      decisionKey: "integrations",
      prompt: "需要哪些集成？",
      type: "multi",
      allowCustom: true,
      options: [
        { id: "o1", label: "GitHub", recommended: true },
        { id: "o2", label: "Slack", recommended: false },
      ],
    },
    {
      id: "r1q3",
      decisionKey: "notes",
      prompt: "还有什么限制？",
      type: "text",
      allowCustom: true,
      options: [],
    },
  ],
};

function setup() {
  const onSubmit = vi.fn();
  const onSkipRest = vi.fn();
  render(<QuestionRoundCard round={round} busy={false} onSubmit={onSubmit} onSkipRest={onSkipRest} />);
  return { onSubmit, onSkipRest, user: userEvent.setup() };
}

describe("QuestionRoundCard", () => {
  it("keeps submit disabled until every question is answered", async () => {
    const { onSubmit, user } = setup();
    const submit = screen.getByRole("button", { name: /提交回答|Submit/ });
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("radio", { name: /Express/ }));
    expect(submit).toBeDisabled();
    await user.click(screen.getByRole("checkbox", { name: /Slack/ }));
    await user.type(screen.getByRole("textbox", { name: /需要哪些集成？/ }), "飞书");
    expect(submit).toBeDisabled();
    await user.type(screen.getByRole("textbox", { name: "还有什么限制？" }), "只用 SQLite");
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith([
      { questionId: "r1q1", optionIds: ["o2"], delegate: false },
      { questionId: "r1q2", optionIds: ["o2"], text: "飞书", delegate: false },
      { questionId: "r1q3", optionIds: [], text: "只用 SQLite", delegate: false },
    ]);
  });

  it("fills the recommended answers and hands open questions to the AI", async () => {
    const { onSubmit, user } = setup();
    // Only open-text questions offer delegation; choice questions already carry a recommendation.
    expect(screen.getAllByRole("checkbox", { name: /让 AI 填写|let the AI fill/i })).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: /填入推荐答案|recommended answers/ }));
    expect(screen.getByRole("radio", { name: /FastAPI/ })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: /让 AI 填写|let the AI fill/i })).toBeChecked();
    await user.click(screen.getByRole("button", { name: /提交回答|Submit/ }));
    expect(onSubmit).toHaveBeenCalledWith([
      { questionId: "r1q1", optionIds: ["o1"], delegate: false },
      { questionId: "r1q2", optionIds: ["o1"], delegate: false },
      { questionId: "r1q3", optionIds: [], delegate: true },
    ]);
  });

  it("offers skipping the rest of the stage", async () => {
    const { onSkipRest, user } = setup();
    await user.click(screen.getByRole("button", { name: /跳过剩余问题|Skip the rest/ }));
    expect(onSkipRest).toHaveBeenCalledOnce();
  });
});
