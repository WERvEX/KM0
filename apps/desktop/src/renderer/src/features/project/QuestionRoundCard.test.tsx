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
  ],
};

function setup() {
  const onSubmit = vi.fn();
  const onAdoptAll = vi.fn();
  render(<QuestionRoundCard round={round} busy={false} onSubmit={onSubmit} onAdoptAll={onAdoptAll} />);
  return { onSubmit, onAdoptAll, user: userEvent.setup() };
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
    await user.click(submit);
    expect(onSubmit).toHaveBeenCalledWith([
      { questionId: "r1q1", optionIds: ["o2"], delegate: false },
      { questionId: "r1q2", optionIds: ["o2"], text: "飞书", delegate: false },
    ]);
  });

  it("fills the recommended answers and supports delegating to the AI", async () => {
    const { onSubmit, user } = setup();
    await user.click(screen.getByRole("button", { name: /填入推荐答案|recommended answers/ }));
    expect(screen.getByRole("radio", { name: /FastAPI/ })).toBeChecked();
    await user.click(screen.getAllByRole("checkbox", { name: /交给 AI 决定|Let the AI decide/ })[1] as HTMLElement);
    await user.click(screen.getByRole("button", { name: /提交回答|Submit/ }));
    expect(onSubmit).toHaveBeenCalledWith([
      { questionId: "r1q1", optionIds: ["o1"], delegate: false },
      { questionId: "r1q2", optionIds: [], delegate: true },
    ]);
  });

  it("offers adopting every recommendation at once", async () => {
    const { onAdoptAll, user } = setup();
    await user.click(screen.getByRole("button", { name: /全部采用推荐|Adopt all/ }));
    expect(onAdoptAll).toHaveBeenCalledOnce();
  });
});
