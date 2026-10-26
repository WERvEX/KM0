#!/usr/bin/env node
// Fails when source code could open a system or browser dialog instead of KM0's own components:
// alert / confirm / prompt, Electron's dialog module, system notifications, unload prompts, and
// the browser's file pickers and downloads outside the few files the browser debug build needs.
// Run with --self-test to check the rules themselves.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = join(import.meta.dirname, "..");
const scanned = ["apps", "packages"];
const skipped = new Set(["node_modules", "out", "release", "dist", "__snapshots__"]);

/** The browser debug build cannot reach the disk otherwise; the desktop app never runs these paths. */
const browserFallbacks = [
  "apps/desktop/src/web/repo-access.ts",
  "apps/desktop/src/web/run-access.ts",
  "apps/desktop/src/renderer/src/lib/browser-files.ts",
];

const rules = [
  {
    id: "native-prompt",
    pattern: /(?<![\w$.])(alert|confirm|prompt)\s*\(|\bwindow\.(alert|confirm|prompt)\b/,
    message: "use ConfirmDialog, a toast or an inline message instead of alert / confirm / prompt",
  },
  {
    id: "electron-dialog",
    pattern: /\bdialog\.show\w*|import\s*\{[^}]*\bdialog\b[^}]*\}\s*from\s*["']electron["']/,
    message: "Electron's dialog module opens system dialogs; use KM0's file browser or an in-app notice",
  },
  {
    id: "system-notification",
    pattern: /\bnew\s+Notification\s*\(|\bNotification\.requestPermission\b/,
    message: "show a toast instead of a system notification",
  },
  {
    id: "unload-prompt",
    pattern: /\bbeforeunload\b|\bonbeforeunload\b/,
    message: "the browser's leave-page prompt is a native dialog; ask with ConfirmDialog instead",
  },
  {
    id: "browser-file-picker",
    pattern: /\bshow(Directory|OpenFile|SaveFile)Picker\b|type\s*=\s*["']file["']|\.download\s*=/,
    message: "use useFiles() (KM0's file browser); only the browser build's fallback files may do this",
    allow: browserFallbacks,
  },
];

/** Drop comments so documentation may name what it avoids. Strings are left as they are. */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

export function check(path, source) {
  const problems = [];
  const lines = stripComments(source).split("\n");
  for (const rule of rules) {
    if (rule.allow?.includes(path)) continue;
    lines.forEach((line, index) => {
      if (rule.pattern.test(line)) problems.push(`${path}:${index + 1}: [${rule.id}] ${rule.message}`);
    });
  }
  return problems;
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipped.has(entry.name) || entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (/\.(ts|tsx|js|mjs|cjs|jsx|html)$/.test(entry.name)) yield full;
  }
}

function selfTest() {
  const bad = [
    'window.alert("x")',
    'if (confirm("sure?")) go();',
    "prompt('name')",
    'import { app, dialog } from "electron";',
    "await dialog.showOpenDialog(win, options);",
    'new Notification("done")',
    'window.addEventListener("beforeunload", stop);',
    'input.type = "file";',
    '<input type="file" />',
    "link.download = name;",
    "await window.showDirectoryPicker();",
  ];
  const good = [
    "onConfirm();",
    "setConfirm(null);",
    "const [confirm, setConfirm] = useState(false);",
    "/** never window.confirm */",
    "// dialog.showOpenDialog is not used",
    'const url = "https://example.com"; // a link',
    "<ConfirmDialog open />",
  ];
  const failures = [];
  for (const line of bad) if (check("x.ts", line).length === 0) failures.push(`not caught: ${line}`);
  for (const line of good) if (check("x.ts", line).length > 0) failures.push(`false alarm: ${line}`);
  if (check(browserFallbacks[2], 'input.type = "file";').length > 0) failures.push("allow list ignored");
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    process.exit(1);
  }
  console.log(`UI rules self-test passed (${bad.length} caught, ${good.length} allowed).`);
}

if (process.argv.includes("--self-test")) {
  selfTest();
} else {
  const problems = [];
  let count = 0;
  for (const top of scanned) {
    for (const file of sourceFiles(join(root, top))) {
      count += 1;
      const path = relative(root, file).split(sep).join("/");
      problems.push(...check(path, readFileSync(file, "utf8")));
    }
  }
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(`\n${problems.length} UI rule violation(s). KM0 shows every prompt in its own components.`);
    process.exit(1);
  }
  console.log(`UI rules: ${count} files checked, no system or browser dialogs.`);
}
