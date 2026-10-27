import type { UpdateState } from "@km0/shared";
import { describe, expect, it } from "vitest";
import { type UpdaterPort, UpdateService } from "./update-service";

function fakePort(
  release: { version: string; notes: string | null } | null | Error = { version: "1.0.1", notes: "fixes" },
) {
  const calls: string[] = [];
  const port: UpdaterPort = {
    async check() {
      calls.push("check");
      if (release instanceof Error) throw release;
      return release;
    },
    async download(onProgress) {
      calls.push("download");
      onProgress(42.4);
      onProgress(100);
    },
    install() {
      calls.push("install");
    },
  };
  return { port, calls };
}

describe("updates", () => {
  it("checks, downloads with progress and installs only when asked", async () => {
    const { port, calls } = fakePort();
    const seen: UpdateState[] = [];
    const updates = new UpdateService(
      port,
      "1.0.0",
      () => "zh-CN",
      (state) => seen.push(state),
      "development",
      () => "now",
    );
    expect(updates.state()).toMatchObject({ status: "idle", currentVersion: "1.0.0" });
    expect(() => updates.install()).toThrow(/还没有下载/);

    expect(await updates.check()).toMatchObject({
      status: "available",
      version: "1.0.1",
      notes: "fixes",
      checkedAt: "now",
    });
    expect(await updates.download()).toMatchObject({ status: "downloaded", percent: 100 });
    expect(seen.map((state) => state.status)).toEqual([
      "checking",
      "available",
      "downloading",
      "downloading",
      "downloading",
      "downloaded",
    ]);
    expect(seen.find((state) => state.percent === 42)).toBeDefined();
    expect(calls).toEqual(["check", "download"]);
    updates.install();
    expect(calls.at(-1)).toBe("install");
  });

  it("says when it is current, when checking failed, and does not check on start when turned off", async () => {
    const current = new UpdateService(fakePort(null).port, "1.0.0", () => "en");
    expect(await current.check()).toMatchObject({ status: "current", version: null });
    // Nothing to download when nothing is available.
    expect(await current.download()).toMatchObject({ status: "current" });

    const failing = new UpdateService(fakePort(new Error("offline")).port, "1.0.0", () => "en");
    expect(await failing.check()).toMatchObject({ status: "error", detail: "offline" });

    const { port, calls } = fakePort();
    const off = new UpdateService(port, "1.0.0", () => "en");
    await off.checkOnStart(false);
    expect(calls).toEqual([]);
    await off.checkOnStart(true);
    expect(calls).toEqual(["check"]);
  });

  it("explains why it cannot update a development build, the browser build or a non-AppImage Linux install", async () => {
    expect(new UpdateService(null, "1.0.0", () => "zh-CN").state()).toMatchObject({
      status: "unsupported",
      detail: "开发版本不自动更新。",
    });
    expect(new UpdateService(null, "1.0.0", () => "en", undefined, "linux").state().detail).toMatch(/AppImage/);
    const web = new UpdateService(null, "1.0.0", () => "en", undefined, "web");
    expect(await web.check()).toMatchObject({ status: "unsupported" });
  });
});
