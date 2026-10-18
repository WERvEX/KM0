import { describe, expect, it } from "vitest";
import { decisionsFromScan } from "./prefill";
import { manifestDeps, type RepoFs, repoSummary, scanRepo } from "./scan";

/** An in-memory repository: paths to contents. */
function memoryFs(files: Record<string, string>): RepoFs & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    async list(dir) {
      const prefix = dir ? `${dir}/` : "";
      const entries = new Map<string, boolean>();
      for (const path of Object.keys(files)) {
        if (!path.startsWith(prefix)) continue;
        const [head, ...rest] = path.slice(prefix.length).split("/");
        entries.set(head as string, rest.length > 0 || (entries.get(head as string) ?? false));
      }
      return [...entries].map(([name, isDir]) => ({ name, dir: isDir }));
    },
    async read(file, maxBytes) {
      reads.push(file);
      return files[file]?.slice(0, maxBytes) ?? null;
    },
  };
}

const opts = { root: "/work/app", name: "app", now: () => "2026-10-18T00:00:00.000Z" };

describe("scanRepo", () => {
  it("recognises a Node web app with a database and Docker", async () => {
    const fs = memoryFs({
      "package.json": JSON.stringify({
        dependencies: { react: "^19", express: "^5", pg: "^8" },
        devDependencies: { vite: "^8", vitest: "^5" },
      }),
      "pnpm-lock.yaml": "",
      "README.md": "# App\nA team ledger.",
      Dockerfile: "FROM node:22",
      "docker-compose.yml": "services:\n  db:\n    image: postgres:17\n  cache:\n    image: redis:7",
      ".github/workflows/ci.yml": "on: push",
      "src/main.tsx": "",
      "src/server/index.ts": "",
      "src/server/index.test.ts": "",
      "node_modules/react/package.json": JSON.stringify({ dependencies: { "left-pad": "1" } }),
    });
    const scan = await scanRepo(fs, opts);
    expect(scan.stack.map((item) => `${item.layer}:${item.name}`)).toEqual([
      "frontend:React",
      "frontend:Vite",
      "backend:Express",
      "storage:PostgreSQL",
      "storage:Redis",
      "deployment:Docker Compose",
      "deployment:Docker",
    ]);
    expect(scan).toMatchObject({
      name: "app",
      fileCount: 9,
      truncated: false,
      packageManagers: ["pnpm"],
      hasTests: true,
      hasCi: true,
      readme: "# App\nA team ledger.",
      languages: [{ name: "TypeScript", files: 3 }],
    });
    // Dependencies inside node_modules are never read.
    expect(fs.reads.some((path) => path.startsWith("node_modules"))).toBe(false);
  });

  it("recognises a Python service", async () => {
    const scan = await scanRepo(
      memoryFs({
        "pyproject.toml": '[project]\ndependencies = ["fastapi>=0.120", "sqlalchemy[asyncio]", "psycopg[binary]"]',
        "app/main.py": "",
        "tests/test_main.py": "",
      }),
      opts,
    );
    expect(scan.stack.map((item) => item.name)).toEqual(["FastAPI", "SQLAlchemy", "PostgreSQL"]);
    expect(scan.languages).toEqual([{ name: "Python", files: 2 }]);
    expect(scan.hasTests).toBe(true);
  });

  it("finds nothing in an empty folder without failing", async () => {
    const scan = await scanRepo(memoryFs({}), opts);
    expect(scan).toMatchObject({ fileCount: 0, stack: [], languages: [], readme: null });
  });
});

describe("manifestDeps", () => {
  it("reads go.mod, Cargo.toml and requirements.txt", () => {
    expect(manifestDeps("go.mod", "module x\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n)\n")).toEqual([
      "github.com/gin-gonic/gin",
    ]);
    expect(
      manifestDeps("Cargo.toml", '[package]\nname = "x"\n\n[dependencies]\naxum = "0.8"\nsqlx = { version = "0.8" }\n'),
    ).toEqual(["axum", "sqlx"]);
    expect(manifestDeps("requirements.txt", "Django==5.2  # web\n\n-r base.txt\nredis\n")).toEqual(["django", "redis"]);
  });
});

describe("decisionsFromScan", () => {
  it("prefills only the layers it recognised, with the source file as the reason", async () => {
    const scan = await scanRepo(
      memoryFs({ "package.json": JSON.stringify({ dependencies: { vue: "3", fastify: "5" } }) }),
      opts,
    );
    const drafts = decisionsFromScan(scan, "zh-CN");
    expect(drafts.map((draft) => [draft.key, draft.value.text, draft.source])).toEqual([
      ["frontend", "Vue", "ai"],
      ["backend", "Fastify", "ai"],
    ]);
    expect(drafts[0]?.rationale).toContain("package.json");
    expect(repoSummary(scan)).toContain("Detected frontend: Vue.");
  });
});
