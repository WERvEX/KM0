import type { ChatProvider, ChatRequest, ChatResponse } from "./types";

export type FakeReply = ChatResponse | Error | ((request: ChatRequest) => ChatResponse | Error);

/** Scripted provider for tests: answers requests in order and remembers what it was asked. */
export class FakeProvider implements ChatProvider {
  readonly requests: ChatRequest[] = [];
  private readonly replies: FakeReply[];

  constructor(replies: FakeReply[]) {
    this.replies = [...replies];
  }

  async complete(request: ChatRequest): Promise<ChatResponse> {
    this.requests.push(request);
    const next = this.replies.shift();
    if (next === undefined) throw new Error("FakeProvider has no reply left");
    const reply = typeof next === "function" ? next(request) : next;
    if (reply instanceof Error) throw reply;
    return reply;
  }

  /** Replays the scripted text in a few pieces. */
  async stream(request: ChatRequest, onDelta: (text: string) => void): Promise<ChatResponse> {
    const reply = await this.complete(request);
    for (const piece of reply.text.match(/[\s\S]{1,40}/g) ?? []) onDelta(piece);
    return reply;
  }
}

export function textReply(text: string, usage = { inputTokens: 10, outputTokens: 5 }): ChatResponse {
  return { text, usage };
}

export function toolReply(input: unknown, usage = { inputTokens: 10, outputTokens: 5 }): ChatResponse {
  return { text: "", toolInput: input, usage };
}
