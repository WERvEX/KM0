import { AppError, DOCUMENT_TEMPLATES, type LlmRole, splitSections } from "@km0/shared";
import type { DiscussionLlm } from "../discussion/engine";
import type { TextCall } from "../llm/gateway";
import {
  type DocumentPromptInput,
  documentPrompt,
  documentSystem,
  type RevisionPromptInput,
  revisionPrompt,
  revisionSystem,
} from "./prompts";

/** The model port for documents: the discussion's structured calls plus streamed text. */
export interface DocumentLlm extends DiscussionLlm {
  stream(
    role: LlmRole,
    call: Omit<TextCall, "profile" | "projectId">,
    onDelta: (text: string) => void,
  ): Promise<string>;
}

/** Room for a long document; thinking on current Claude models counts toward the same limit. */
const DOCUMENT_MAX_TOKENS = 16_000;

/**
 * Write a whole document in one streamed planner call. Sections the model left out come back
 * missing from the map; the caller stores them empty so they can be written one by one.
 */
export async function writeDocument(
  llm: DocumentLlm,
  input: DocumentPromptInput,
  onDelta: (text: string) => void,
): Promise<Map<string, string>> {
  const ids = DOCUMENT_TEMPLATES[input.kind].sections.map((item) => item.id);
  const text = await llm.stream(
    "planner",
    {
      purpose: `document.${input.kind}`,
      system: documentSystem(input),
      prompt: documentPrompt(input),
      maxTokens: DOCUMENT_MAX_TOKENS,
      effort: "medium",
    },
    onDelta,
  );
  const bodies = splitSections(text, ids);
  if (bodies.size === 0) {
    throw new AppError("validation", "The model did not write the document in sections.", {
      retryable: true,
      detail: text.slice(0, 200),
    });
  }
  return bodies;
}

/** Rewrite only the target sections, following an instruction or the current decisions. */
export async function reviseSections(llm: DocumentLlm, input: RevisionPromptInput): Promise<Map<string, string>> {
  const text = await llm.stream(
    "planner",
    {
      purpose: `document.${input.kind}.revise`,
      system: revisionSystem(input),
      prompt: revisionPrompt(input),
      maxTokens: DOCUMENT_MAX_TOKENS,
      effort: "medium",
    },
    () => undefined,
  );
  // Whatever else the model wrote, only the requested sections are taken.
  const bodies = splitSections(text, input.targetIds);
  if (bodies.size === 0) {
    throw new AppError("validation", "The model did not return the sections to revise.", {
      retryable: true,
      detail: text.slice(0, 200),
    });
  }
  return bodies;
}
