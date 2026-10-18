import type { RepoScan, StackItem, StackLayer } from "@km0/shared";

/** Read-only access to a repository. Paths are relative to its root and use forward slashes. */
export interface RepoFs {
  list(dir: string): Promise<{ name: string; dir: boolean }[]>;
  /** The file's text, cut at `maxBytes`; null when it cannot be read. */
  read(file: string, maxBytes: number): Promise<string | null>;
}

const MAX_FILES = 5000;
const MAX_DEPTH = 6;
const MANIFEST_BYTES = 200_000;
const README_CHARS = 1500;

const SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "bower_components",
  "vendor",
  "dist",
  "build",
  "out",
  "target",
  "coverage",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "env",
  "__pycache__",
  ".idea",
  ".vscode",
  "Pods",
  "DerivedData",
]);

const LANGUAGES: Record<string, string> = {
  ts: "TypeScript",
  tsx: "TypeScript",
  mts: "TypeScript",
  cts: "TypeScript",
  js: "JavaScript",
  jsx: "JavaScript",
  mjs: "JavaScript",
  cjs: "JavaScript",
  vue: "Vue",
  svelte: "Svelte",
  py: "Python",
  go: "Go",
  rs: "Rust",
  java: "Java",
  kt: "Kotlin",
  kts: "Kotlin",
  scala: "Scala",
  cs: "C#",
  fs: "F#",
  cpp: "C++",
  cc: "C++",
  cxx: "C++",
  hpp: "C++",
  c: "C",
  h: "C",
  m: "Objective-C",
  swift: "Swift",
  rb: "Ruby",
  php: "PHP",
  dart: "Dart",
  ex: "Elixir",
  exs: "Elixir",
  lua: "Lua",
  sql: "SQL",
  sh: "Shell",
  ps1: "PowerShell",
  html: "HTML",
  css: "CSS",
  scss: "CSS",
  less: "CSS",
};

/** Dependency name (exact, or a prefix ending in "/" or "*") → recognised technology. */
type Rule = [pattern: string, layer: StackLayer, name: string];

const NODE_RULES: Rule[] = [
  ["next", "frontend", "Next.js"],
  ["nuxt", "frontend", "Nuxt"],
  ["@remix-run/*", "frontend", "Remix"],
  ["@sveltejs/kit", "frontend", "SvelteKit"],
  ["astro", "frontend", "Astro"],
  ["react", "frontend", "React"],
  ["vue", "frontend", "Vue"],
  ["svelte", "frontend", "Svelte"],
  ["@angular/core", "frontend", "Angular"],
  ["solid-js", "frontend", "Solid"],
  ["react-native", "frontend", "React Native"],
  ["expo", "frontend", "Expo"],
  ["electron", "frontend", "Electron"],
  ["@tauri-apps/api", "frontend", "Tauri"],
  ["tailwindcss", "frontend", "Tailwind CSS"],
  ["vite", "frontend", "Vite"],
  ["express", "backend", "Express"],
  ["fastify", "backend", "Fastify"],
  ["koa", "backend", "Koa"],
  ["hono", "backend", "Hono"],
  ["@nestjs/core", "backend", "NestJS"],
  ["@trpc/server", "backend", "tRPC"],
  ["@apollo/server", "backend", "Apollo GraphQL"],
  ["prisma", "storage", "Prisma"],
  ["@prisma/client", "storage", "Prisma"],
  ["drizzle-orm", "storage", "Drizzle ORM"],
  ["typeorm", "storage", "TypeORM"],
  ["sequelize", "storage", "Sequelize"],
  ["mongoose", "storage", "MongoDB"],
  ["mongodb", "storage", "MongoDB"],
  ["pg", "storage", "PostgreSQL"],
  ["postgres", "storage", "PostgreSQL"],
  ["mysql2", "storage", "MySQL"],
  ["mysql", "storage", "MySQL"],
  ["better-sqlite3", "storage", "SQLite"],
  ["sqlite3", "storage", "SQLite"],
  ["sql.js", "storage", "SQLite"],
  ["redis", "storage", "Redis"],
  ["ioredis", "storage", "Redis"],
  ["@supabase/supabase-js", "storage", "Supabase"],
  ["firebase", "storage", "Firebase"],
  ["electron-builder", "deployment", "electron-builder"],
  ["@vercel/*", "deployment", "Vercel"],
  ["wrangler", "deployment", "Cloudflare Workers"],
];

const PYTHON_RULES: Rule[] = [
  ["django", "backend", "Django"],
  ["flask", "backend", "Flask"],
  ["fastapi", "backend", "FastAPI"],
  ["starlette", "backend", "Starlette"],
  ["streamlit", "frontend", "Streamlit"],
  ["gradio", "frontend", "Gradio"],
  ["pyqt*", "frontend", "Qt (PyQt)"],
  ["pyside*", "frontend", "Qt (PySide)"],
  ["sqlalchemy", "storage", "SQLAlchemy"],
  ["psycopg*", "storage", "PostgreSQL"],
  ["asyncpg", "storage", "PostgreSQL"],
  ["pymysql", "storage", "MySQL"],
  ["pymongo", "storage", "MongoDB"],
  ["redis", "storage", "Redis"],
];

const GO_RULES: Rule[] = [
  ["github.com/gin-gonic/gin", "backend", "Gin"],
  ["github.com/labstack/echo*", "backend", "Echo"],
  ["github.com/gofiber/fiber*", "backend", "Fiber"],
  ["github.com/go-chi/chi*", "backend", "chi"],
  ["gorm.io/gorm", "storage", "GORM"],
  ["github.com/jackc/pgx*", "storage", "PostgreSQL"],
  ["github.com/lib/pq", "storage", "PostgreSQL"],
  ["github.com/go-sql-driver/mysql", "storage", "MySQL"],
  ["github.com/mattn/go-sqlite3", "storage", "SQLite"],
  ["go.mongodb.org/mongo-driver*", "storage", "MongoDB"],
  ["github.com/redis/go-redis*", "storage", "Redis"],
];

const RUST_RULES: Rule[] = [
  ["axum", "backend", "Axum"],
  ["actix-web", "backend", "Actix Web"],
  ["rocket", "backend", "Rocket"],
  ["tauri", "frontend", "Tauri"],
  ["leptos", "frontend", "Leptos"],
  ["yew", "frontend", "Yew"],
  ["diesel", "storage", "Diesel"],
  ["sqlx", "storage", "SQLx"],
  ["rusqlite", "storage", "SQLite"],
  ["sea-orm", "storage", "SeaORM"],
];

const JVM_RULES: Rule[] = [
  ["spring-boot", "backend", "Spring Boot"],
  ["quarkus", "backend", "Quarkus"],
  ["micronaut", "backend", "Micronaut"],
  ["ktor", "backend", "Ktor"],
  ["postgresql", "storage", "PostgreSQL"],
  ["mysql-connector", "storage", "MySQL"],
  ["hibernate", "storage", "Hibernate"],
  ["mybatis", "storage", "MyBatis"],
];

const DOCKER_IMAGES: Rule[] = [
  ["postgres", "storage", "PostgreSQL"],
  ["mysql", "storage", "MySQL"],
  ["mariadb", "storage", "MariaDB"],
  ["mongo", "storage", "MongoDB"],
  ["redis", "storage", "Redis"],
];

/** Files whose presence alone says something. */
const MARKER_FILES: Record<string, [StackLayer, string]> = {
  Dockerfile: ["deployment", "Docker"],
  "docker-compose.yml": ["deployment", "Docker Compose"],
  "docker-compose.yaml": ["deployment", "Docker Compose"],
  "compose.yml": ["deployment", "Docker Compose"],
  "compose.yaml": ["deployment", "Docker Compose"],
  "vercel.json": ["deployment", "Vercel"],
  "netlify.toml": ["deployment", "Netlify"],
  "fly.toml": ["deployment", "Fly.io"],
  "render.yaml": ["deployment", "Render"],
  "railway.json": ["deployment", "Railway"],
  "wrangler.toml": ["deployment", "Cloudflare Workers"],
  "app.yaml": ["deployment", "Google App Engine"],
  "serverless.yml": ["deployment", "Serverless Framework"],
  Procfile: ["deployment", "Heroku"],
  "electron-builder.yml": ["deployment", "electron-builder"],
  "pubspec.yaml": ["frontend", "Flutter"],
  "manage.py": ["backend", "Django"],
  artisan: ["backend", "Laravel"],
};

const PACKAGE_MANAGERS: Record<string, string> = {
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "Yarn",
  "package-lock.json": "npm",
  "bun.lockb": "Bun",
  "bun.lock": "Bun",
  "poetry.lock": "Poetry",
  "uv.lock": "uv",
  "Pipfile.lock": "Pipenv",
  "requirements.txt": "pip",
  "go.mod": "Go modules",
  "Cargo.toml": "Cargo",
  "pom.xml": "Maven",
  "build.gradle": "Gradle",
  "build.gradle.kts": "Gradle",
  Gemfile: "Bundler",
  "composer.json": "Composer",
};

function matches(pattern: string, name: string): boolean {
  const lower = name.toLowerCase();
  if (pattern.endsWith("*")) return lower.startsWith(pattern.slice(0, -1));
  return lower === pattern;
}

function applyRules(rules: Rule[], names: string[], file: string): StackItem[] {
  const items: StackItem[] = [];
  for (const [pattern, layer, name] of rules) {
    if (names.some((dep) => matches(pattern, dep))) items.push({ layer, name, file });
  }
  return items;
}

/** Dependency names from the manifests KM0 understands. */
export function manifestDeps(file: string, text: string): string[] {
  const base = file.split("/").pop() ?? file;
  if (base === "package.json") {
    try {
      const json = JSON.parse(text) as Record<string, Record<string, unknown> | undefined>;
      return ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((field) =>
        Object.keys(json[field] ?? {}),
      );
    } catch {
      return [];
    }
  }
  if (base === "requirements.txt" || base === "Pipfile") {
    return text
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*/, "").trim())
      .filter((line) => line && !line.startsWith("-"))
      .map((line) => (/^[A-Za-z0-9_.\-[\]]+/.exec(line)?.[0] ?? "").replace(/\[.*\]/, "").toLowerCase())
      .filter(Boolean);
  }
  if (base === "pyproject.toml") {
    return [...text.matchAll(/["']([A-Za-z0-9_.-]+)\s*(?:\[[^\]]*\])?\s*(?:[<>=~!^][^"']*)?["']/g)]
      .map((match) => (match[1] as string).toLowerCase())
      .concat([...text.matchAll(/^([A-Za-z0-9_.-]+)\s*=/gm)].map((match) => (match[1] as string).toLowerCase()));
  }
  if (base === "go.mod") {
    return [...text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v/gm)].map(
      (match) => match[1] as string,
    );
  }
  if (base === "Cargo.toml") {
    const deps = /\[(?:[a-z-]*\.)?dependencies\]([\s\S]*?)(?:\n\[|$)/g;
    return [...text.matchAll(deps)].flatMap((section) =>
      [...(section[1] as string).matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)].map((match) => match[1] as string),
    );
  }
  if (base === "pom.xml") {
    return [...text.matchAll(/<artifactId>([^<]+)<\/artifactId>/g)].map((match) => match[1] as string);
  }
  if (base === "build.gradle" || base === "build.gradle.kts") {
    return [...text.matchAll(/["']([\w.-]+):([\w.-]+)(?::[^"']*)?["']/g)].map((match) => match[2] as string);
  }
  if (base === "Gemfile") {
    return [...text.matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map((match) => match[1] as string);
  }
  if (base === "composer.json") {
    try {
      const json = JSON.parse(text) as { require?: Record<string, unknown> };
      return Object.keys(json.require ?? {});
    } catch {
      return [];
    }
  }
  return [];
}

function stackFromManifest(file: string, text: string): StackItem[] {
  const base = file.split("/").pop() ?? file;
  const deps = manifestDeps(file, text);
  if (base === "package.json") return applyRules(NODE_RULES, deps, file);
  if (base === "requirements.txt" || base === "Pipfile" || base === "pyproject.toml") {
    return applyRules(PYTHON_RULES, deps, file);
  }
  if (base === "go.mod") return applyRules(GO_RULES, deps, file);
  if (base === "Cargo.toml") return applyRules(RUST_RULES, deps, file);
  if (base === "pom.xml" || base === "build.gradle" || base === "build.gradle.kts") {
    return applyRules(JVM_RULES, deps, file);
  }
  if (base === "Gemfile") {
    return applyRules(
      [
        ["rails", "backend", "Ruby on Rails"],
        ["sinatra", "backend", "Sinatra"],
        ["pg", "storage", "PostgreSQL"],
        ["mysql2", "storage", "MySQL"],
        ["sqlite3", "storage", "SQLite"],
      ],
      deps,
      file,
    );
  }
  if (base === "composer.json") {
    return applyRules(
      [
        ["laravel/framework", "backend", "Laravel"],
        ["symfony/*", "backend", "Symfony"],
      ],
      deps,
      file,
    );
  }
  if (/^(docker-)?compose\.ya?ml$/.test(base)) {
    const images = [...text.matchAll(/^\s*image:\s*["']?([a-z0-9./_-]+)/gm)].map(
      (match) => (match[1] as string).split("/").pop() ?? "",
    );
    return applyRules(DOCKER_IMAGES, images, file);
  }
  if (base === "schema.prisma") {
    const provider = /provider\s*=\s*"(postgresql|mysql|sqlite|mongodb|sqlserver|cockroachdb)"/.exec(text)?.[1];
    const names: Record<string, string> = {
      postgresql: "PostgreSQL",
      mysql: "MySQL",
      sqlite: "SQLite",
      mongodb: "MongoDB",
      sqlserver: "SQL Server",
      cockroachdb: "CockroachDB",
    };
    return provider ? [{ layer: "storage", name: names[provider] as string, file }] : [];
  }
  return [];
}

const MANIFESTS = new Set([
  "package.json",
  "requirements.txt",
  "Pipfile",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Gemfile",
  "composer.json",
  "docker-compose.yml",
  "docker-compose.yaml",
  "compose.yml",
  "compose.yaml",
  "schema.prisma",
]);

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e"]);
const TEST_FILE = /(\.|_)(test|spec)\.[a-z]+$|^test_.*\.py$|_test\.go$/;

export interface ScanOptions {
  root: string;
  name: string;
  now?: () => string;
}

/**
 * Walk a repository without changing anything: count languages, read the dependency manifests
 * near the root and recognise the stack per layer, so stage C can start from what is there.
 */
export async function scanRepo(fs: RepoFs, options: ScanOptions): Promise<RepoScan> {
  const languageCounts = new Map<string, number>();
  const stack: StackItem[] = [];
  const managers = new Set<string>();
  let fileCount = 0;
  let truncated = false;
  let hasTests = false;
  let hasCi = false;
  let topLevel: string[] = [];
  let readme: string | null = null;

  const queue: { dir: string; depth: number }[] = [{ dir: "", depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    let entries: { name: string; dir: boolean }[];
    try {
      entries = await fs.list(dir);
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    if (dir === "") topLevel = entries.map((entry) => (entry.dir ? `${entry.name}/` : entry.name)).slice(0, 40);
    for (const entry of entries) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.dir) {
        if (path === ".github/workflows" || entry.name === ".gitlab-ci" || entry.name === ".circleci") hasCi = true;
        if (TEST_DIRS.has(entry.name)) hasTests = true;
        if (depth + 1 < MAX_DEPTH && (!SKIP_DIRS.has(entry.name) || path === ".github")) {
          if (!entry.name.startsWith(".") || entry.name === ".github") queue.push({ dir: path, depth: depth + 1 });
        }
        continue;
      }
      fileCount += 1;
      if (fileCount > MAX_FILES) {
        truncated = true;
        break;
      }
      if (entry.name === ".gitlab-ci.yml" || entry.name === "Jenkinsfile" || entry.name === "azure-pipelines.yml") {
        hasCi = true;
      }
      if (TEST_FILE.test(entry.name)) hasTests = true;
      const ext = entry.name.includes(".") ? (entry.name.split(".").pop() ?? "").toLowerCase() : "";
      const language = LANGUAGES[ext];
      if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);

      // Manifests and markers count near the root only; deep ones are usually fixtures or examples.
      if (depth > 2) continue;
      if (depth === 0 && PACKAGE_MANAGERS[entry.name]) managers.add(PACKAGE_MANAGERS[entry.name] as string);
      const marker = MARKER_FILES[entry.name];
      if (marker) stack.push({ layer: marker[0], name: marker[1], file: path });
      if (MANIFESTS.has(entry.name)) {
        const text = await fs.read(path, MANIFEST_BYTES);
        if (text) stack.push(...stackFromManifest(path, text));
      }
      if (depth === 0 && readme === null && /^readme(\.md|\.markdown|\.txt|\.rst)?$/i.test(entry.name)) {
        const text = await fs.read(path, README_CHARS * 4);
        readme = text ? text.slice(0, README_CHARS).trim() : null;
      }
    }
    if (truncated) break;
  }

  const languages = [...languageCounts.entries()]
    .map(([name, files]) => ({ name, files }))
    .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
    .slice(0, 8);
  if (languages.some((language) => language.name === "HTML") && !stack.some((item) => item.layer === "frontend")) {
    stack.push({ layer: "frontend", name: "HTML/CSS", file: "" });
  }
  return {
    root: options.root,
    name: options.name,
    fileCount: Math.min(fileCount, MAX_FILES),
    truncated,
    languages,
    stack: dedupe(stack),
    packageManagers: [...managers],
    hasTests,
    hasCi,
    topLevel,
    readme,
    scannedAt: (options.now ?? (() => new Date().toISOString()))(),
  };
}

const LAYER_ORDER: StackLayer[] = ["frontend", "backend", "storage", "deployment"];

/** One entry per technology, grouped by layer in discovery order. */
function dedupe(items: StackItem[]): StackItem[] {
  const seen = new Set<string>();
  const unique = items.filter((item) => {
    const id = `${item.layer}:${item.name}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return LAYER_ORDER.flatMap((layer) => unique.filter((item) => item.layer === layer));
}

/** Names per layer, in the order found. */
export function stackByLayer(scan: RepoScan): Record<StackLayer, string[]> {
  const result: Record<StackLayer, string[]> = { frontend: [], backend: [], storage: [], deployment: [] };
  for (const item of scan.stack) result[item.layer].push(item.name);
  return result;
}

/** A compact description of the repository for prompts. */
export function repoSummary(scan: RepoScan): string {
  const layers = stackByLayer(scan);
  const lines = [
    `Repository "${scan.name}": ${scan.fileCount}${scan.truncated ? "+" : ""} files.`,
    scan.languages.length > 0
      ? `Languages: ${scan.languages.map((language) => `${language.name} (${language.files})`).join(", ")}.`
      : "",
    ...(Object.keys(layers) as StackLayer[])
      .filter((layer) => layers[layer].length > 0)
      .map((layer) => `Detected ${layer}: ${layers[layer].join(", ")}.`),
    scan.packageManagers.length > 0 ? `Package managers: ${scan.packageManagers.join(", ")}.` : "",
    `Tests: ${scan.hasTests ? "yes" : "none found"}. CI: ${scan.hasCi ? "yes" : "none found"}.`,
    scan.topLevel.length > 0 ? `Top level: ${scan.topLevel.join(" ")}` : "",
    scan.readme ? `README excerpt:\n${scan.readme.slice(0, 800)}` : "",
  ];
  return lines.filter(Boolean).join("\n");
}
