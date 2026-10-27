import type { FolderRequest } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { FolderRequests } from "./folder-requests";

function setup() {
  const sent: FolderRequest[] = [];
  const folders = new FolderRequests((event, payload) => {
    if (event === "folder.request") sent.push(payload as FolderRequest);
  });
  return { folders, sent };
}

describe("FolderRequests", () => {
  it("asks the window and resolves with its answer", async () => {
    const { folders, sent } = setup();
    const answer = folders.ask("repo");
    expect(sent).toEqual([{ requestId: expect.any(String), purpose: "repo" }]);
    folders.answer({ requestId: sent[0]?.requestId ?? "", path: "/work/app" });
    await expect(answer).resolves.toBe("/work/app");
  });

  it("ignores answers to other requests", async () => {
    const { folders, sent } = setup();
    const answer = folders.ask("run");
    folders.answer({ requestId: "someone-else", path: "/tmp" });
    folders.answer({ requestId: sent[0]?.requestId ?? "", path: null });
    await expect(answer).resolves.toBeNull();
  });

  it("cancels the open request when a new one starts or the window goes away", async () => {
    const { folders, sent } = setup();
    const first = folders.ask("repo");
    const second = folders.ask("run");
    await expect(first).resolves.toBeNull();
    expect(sent[0]?.requestId).not.toBe(sent[1]?.requestId);
    folders.cancel();
    await expect(second).resolves.toBeNull();
  });
});
