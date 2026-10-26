import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { DiscussionLlm } from "@km0/core";
import type { LlmRole } from "@km0/shared";

/**
 * Recorded model answers, so the eval replays without an API key. Each answer is keyed by what was asked:
 * the role, the call's name, its system prompt and its prompt. A changed prompt changes the key, so after a
 * prompt change the answers have to be recorded again (`pnpm --filter @km0/eval record`).
 */

export interface Recording {
  key: string;
  purpose: string;
  /** Which eval case asked, for reading the file. */
  caseId: string;
  output: unknown;
}

type Call = Parameters<DiscussionLlm["structured"]>[1];

export function callKey(role: LlmRole, call: Pick<Call, "name" | "system" | "prompt">): string {
  return createHash("sha256")
    .update(JSON.stringify([role, call.name, call.system ?? "", call.prompt]))
    .digest("hex")
    .slice(0, 24);
}

export class Cassette {
  private readonly answers = new Map<string, Recording>();

  constructor(private readonly path: string | null = null) {
    if (path && existsSync(path)) {
      for (const line of readFileSync(path, "utf8").split("\n").filter(Boolean)) {
        const recording = JSON.parse(line) as Recording;
        this.answers.set(recording.key, recording);
      }
    }
  }

  get size(): number {
    return this.answers.size;
  }

  find(key: string): Recording | undefined {
    return this.answers.get(key);
  }

  add(recording: Recording): void {
    this.answers.set(recording.key, recording);
  }

  save(): void {
    if (!this.path) return;
    const lines = [...this.answers.values()].sort(
      (a, b) => a.caseId.localeCompare(b.caseId) || a.key.localeCompare(b.key),
    );
    writeFileSync(
      this.path,
      lines
        .map((line) => JSON.stringify(line))
        .join("\n")
        .concat(lines.length ? "\n" : ""),
    );
  }
}

/** A recorded answer is missing: the prompt changed since the recording, or the case is new. */
export class MissingRecording extends Error {
  constructor(
    readonly caseId: string,
    readonly purpose: string,
  ) {
    super(`No recorded answer for ${caseId} (${purpose}); record again with \`pnpm --filter @km0/eval record\`.`);
  }
}

/** Answers from the cassette only; nothing leaves the machine. */
export function replaying(cassette: Cassette, caseId: () => string): DiscussionLlm {
  return {
    async structured(role, call) {
      const found = cassette.find(callKey(role, call));
      if (!found) throw new MissingRecording(caseId(), call.purpose);
      return call.schema.parse(found.output);
    },
  };
}

/** Asks a real model (or a bridge) and keeps every answer in the cassette. */
export function recording(live: DiscussionLlm, cassette: Cassette, caseId: () => string): DiscussionLlm {
  return {
    async structured(role, call) {
      const key = callKey(role, call);
      const known = cassette.find(key);
      if (known) return call.schema.parse(known.output);
      const output = await live.structured(role, call);
      cassette.add({ key, purpose: call.purpose, caseId: caseId(), output });
      cassette.save();
      return output;
    },
  };
}
