import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeRepoAccess, nodeRepoFs } from "./node-repo-access";
import { scanPath } from "./services/repo-access";

let root: string;
let outside: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "km0-repo-"));
  outside = await mkdtemp(join(tmpdir(), "km0-outside-"));
  await writeFile(join(outside, "secret.txt"), "do not read");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "package.json"), JSON.stringify({ dependencies: { next: "16" } }));
  await writeFile(join(root, "src", "page.tsx"), "export default function Page() {}");
  await symlink(outside, join(root, "linked"), "dir").catch(() => undefined);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("nodeRepoAccess", () => {
  it("scans a folder on disk", async () => {
    const scan = await scanPath(
      nodeRepoAccess(async () => null),
      root,
    );
    expect(scan).toMatchObject({
      root,
      fileCount: 2,
      stack: [{ layer: "frontend", name: "Next.js", file: "package.json" }],
    });
  });

  it("does not follow links or paths out of the folder", async () => {
    const fs = nodeRepoFs(root);
    expect((await fs.list("")).map((entry) => entry.name).sort()).toEqual(["package.json", "src"]);
    await expect(fs.list("../")).rejects.toThrow("escapes");
    expect(await fs.read("../secret.txt", 100)).toBeNull();
  });

  it("rejects relative and missing paths", async () => {
    const access = nodeRepoAccess(async () => null);
    await expect(access.open("relative/path")).rejects.toMatchObject({ kind: "validation" });
    await expect(access.open(join(root, "missing"))).rejects.toMatchObject({ kind: "validation" });
  });
});
