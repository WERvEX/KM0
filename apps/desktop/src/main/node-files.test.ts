import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "@km0/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nodeFiles } from "./node-files";

let root: string;
const revealed: string[] = [];
const files = nodeFiles((path) => revealed.push(path));
const browse = (path: string | null, extensions: string[] = [], showHidden = false) =>
  files.browse({ path, extensions, showHidden });

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "km0-files-"));
  await mkdir(join(root, "repo", ".git"), { recursive: true });
  await mkdir(join(root, "notes"));
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, "config.json"), '{"a":1}');
  await writeFile(join(root, "readme.md"), "# hi");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("nodeFiles", () => {
  it("lists folders first, marks git repositories and hides dot folders", async () => {
    const listing = await browse(root);
    expect(listing.path).toBe(root);
    expect(listing.parent).not.toBeNull();
    expect(listing.entries.map((entry) => entry.name)).toEqual(["notes", "repo"]);
    expect(listing.entries.find((entry) => entry.name === "repo")?.git).toBe(true);
    expect(listing.places[0]?.id).toBe("home");
  });

  it("lists files with the requested extensions, and hidden folders on request", async () => {
    const listing = await browse(root, ["json"], true);
    expect(listing.entries.map((entry) => [entry.name, entry.dir])).toEqual([
      [".hidden", true],
      ["notes", true],
      ["repo", true],
      ["config.json", false],
    ]);
  });

  it("starts in the home folder and rejects relative or missing paths", async () => {
    expect((await browse(null)).places.some((place) => place.id === "home")).toBe(true);
    await expect(browse("relative/path")).rejects.toBeInstanceOf(AppError);
    await expect(browse(join(root, "missing"))).rejects.toThrow(/cannot be opened/);
  });

  it("reads a file for an import", async () => {
    expect(await files.read(join(root, "config.json"))).toEqual({ name: "config.json", text: '{"a":1}' });
    await expect(files.read(join(root, "notes"))).rejects.toThrow(/does not exist/);
  });

  it("saves text and bytes, and asks before overwriting", async () => {
    const saved = await files.save({ dir: root, name: "out.md", content: "one", encoding: "utf8", overwrite: false });
    expect(saved).toBe(join(root, "out.md"));
    const again = files.save({ dir: root, name: "out.md", content: "two", encoding: "utf8", overwrite: false });
    await expect(again).rejects.toMatchObject({ kind: "conflict" });
    await files.save({ dir: root, name: "out.md", content: "two", encoding: "utf8", overwrite: true });
    expect(await readFile(saved, "utf8")).toBe("two");

    const zip = await files.save({
      dir: root,
      name: "out.zip",
      content: Buffer.from([80, 75, 3, 4]).toString("base64"),
      encoding: "base64",
      overwrite: false,
    });
    expect([...(await readFile(zip))]).toEqual([80, 75, 3, 4]);
    await expect(
      files.save({ dir: join(root, "missing"), name: "x", content: "", encoding: "utf8", overwrite: false }),
    ).rejects.toThrow(/does not exist/);
  });

  it("reveals a saved file through the injected shell", async () => {
    await files.reveal(join(root, "config.json"));
    expect(revealed).toEqual([join(root, "config.json")]);
  });
});
