import { type Decision, DOCUMENT_TEMPLATES, type DocumentKind, SECTION_MARKER, type Triage } from "@km0/shared";
import { keyDef } from "../discussion/catalog";
import { type Language, languageRule } from "../discussion/prompts";

/** What each section should contain, keyed by `<kind>.<section id>`. */
const SECTION_GUIDES: Record<string, string> = {
  "prd.background": "The problem, who has it, and the goals of this project. 3-6 sentences or bullets.",
  "prd.positioning": "Delivery form, expected user scale and data volume, compliance, time and budget. A short list.",
  "prd.users_scenarios":
    "Target users and their roles, including whether and how they sign in and what each role may do; then the core scenarios as numbered user stories.",
  "prd.functional":
    "One ### subsection per MVP feature: a one-line description and 2-4 acceptance criteria in EARS form. End with a short list of features planned for later.",
  "prd.non_functional":
    "Performance, availability, security, privacy, compatibility and accessibility requirements that follow from the scale and compliance decisions. Only concrete, checkable items.",
  "prd.non_goals": "What is explicitly out of scope for this release.",
  "prd.success": "Measurable success criteria, each with a target value or an observable signal.",
  "prd.open_questions":
    "Decisions still open or pending, assumptions made on the user's behalf that deserve a check, and anything the ledger leaves unsettled. Write only 'None.' (or '无。') if there is nothing.",

  "tech_design.stack":
    "A table with columns layer | choice | why | rejected alternatives, for frontend, backend, storage, deployment, authentication and integrations (skip layers that do not apply).",
  "tech_design.architecture":
    "The main components and how they talk to each other. Add a small Mermaid diagram (```mermaid) when it helps.",
  "tech_design.modules": "Modules or packages with their responsibilities and main dependencies, as a table.",
  "tech_design.data_model":
    "Core entities with their key fields and relations, plus storage-specific notes such as indexes and migrations.",
  "tech_design.interfaces":
    "Main API endpoints, commands or IPC calls (method, path or name, purpose) and third-party integrations.",
  "tech_design.deployment": "How it is built, configured, packaged, hosted and released; environments; CI/CD.",
  "tech_design.security":
    "Authentication and authorization implementation, secret handling, data protection and compliance measures.",
  "tech_design.testing":
    "What is tested at which level (unit, integration, end-to-end), with which tools, and what gates a release.",
  "tech_design.milestones": "Ordered milestones; for each, the deliverable and how to tell it is done.",
  "tech_design.risks": "Main technical risks as a table: risk | impact | mitigation.",

  "brief.goal": "What this piece of work achieves and why, in 2-4 sentences.",
  "brief.scope": "In scope and out of scope, as two short lists.",
  "brief.approach":
    "The technical approach: where it plugs into the existing system, the main changes, and the modules or files likely touched.",
  "brief.constraints":
    "Compatibility, performance, security or time constraints. Write only 'None.' (or '无。') if none apply.",
  "brief.acceptance": "3-6 acceptance criteria in EARS form.",
  "brief.open_questions":
    "Anything the decisions leave unsettled and assumptions worth a check. Write only 'None.' (or '无。') if there is nothing.",
};

export function sectionGuide(kind: DocumentKind, id: string): string {
  return SECTION_GUIDES[`${kind}.${id}`] ?? "";
}

export interface DocumentPromptInput {
  language: Language;
  kind: DocumentKind;
  title: string;
  description: string;
  triage: Triage | null;
  decisions: Decision[];
}

const SOURCE_LABEL: Record<Decision["source"], string> = {
  user: "chosen by the user",
  recommended: "recommended option accepted",
  ai: "decided by AI on the user's behalf",
};

function describeDecision(decision: Decision, language: Language): string {
  const label = keyDef(decision.key)?.label[language] ?? decision.key;
  const notes = [SOURCE_LABEL[decision.source]];
  if (decision.rationale) notes.push(`why: ${decision.rationale}`);
  if (decision.alternatives.length > 0) notes.push(`rejected: ${decision.alternatives.join(" / ")}`);
  if (decision.needsReview) notes.push("flagged for review");
  return `- ${label} (${decision.key}): ${decision.value.text} [${notes.join("; ")}]`;
}

function contextBlock(input: DocumentPromptInput): string {
  const ledger =
    input.decisions.length > 0
      ? input.decisions.map((decision) => describeDecision(decision, input.language)).join("\n")
      : "(empty)";
  return [
    `Project: ${input.title}`,
    `Task description:\n${input.description}`,
    input.triage
      ? `Triage: ${input.triage.taskType}, complexity ${input.triage.complexity}. ${input.triage.summary}`
      : "",
    `Decision ledger:\n${ledger}`,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function sectionList(input: DocumentPromptInput, ids?: readonly string[]): string {
  return DOCUMENT_TEMPLATES[input.kind].sections
    .filter((item) => !ids || ids.includes(item.id))
    .map((item) => `- ${item.id} (${item.title[input.language]}): ${sectionGuide(input.kind, item.id)}`)
    .join("\n");
}

function writingRules(input: DocumentPromptInput): string[] {
  const docTitle = DOCUMENT_TEMPLATES[input.kind].title.en.toLowerCase();
  return [
    `You are KM0's technical writer. You turn a settled decision ledger into a ${docTitle} document that both a coding agent and a human reviewer can work from.`,
    "The decision ledger is the source of truth. Never contradict it and never quietly add major decisions it does not contain. When you must assume something, say so explicitly and list the assumption under open questions.",
    "Be concise and concrete: short paragraphs, bullet lists and tables; real names of technologies, features and roles. No marketing language, no filler, no restating these instructions.",
    input.language === "zh-CN"
      ? "Write acceptance criteria in EARS form: 「当……时，系统应当……」 (or 「系统应当……」 for always-on requirements)."
      : "Write acceptance criteria in EARS form: 'When <trigger>, the system shall <response>.' (or 'The system shall …' for always-on requirements).",
    `Output format: for each section, a line containing only \`${SECTION_MARKER}<id>\`, then the section body in Markdown. Do not write section titles; KM0 adds them. Inside a section use only ### or deeper headings. Write nothing before the first marker.`,
    languageRule(input.language),
  ];
}

export function documentSystem(input: DocumentPromptInput): string {
  return writingRules(input).join("\n");
}

export function documentPrompt(input: DocumentPromptInput): string {
  return `${contextBlock(input)}\n\nSections, in order:\n${sectionList(input)}`;
}

export interface RevisionPromptInput extends DocumentPromptInput {
  current: readonly { id: string; title: string; body: string }[];
  targetIds: readonly string[];
  instruction: string | null;
}

export function revisionSystem(input: RevisionPromptInput): string {
  return [
    ...writingRules(input),
    "You are revising an existing document. Rewrite only the sections you are asked for, keep them consistent with the rest of the document, and output only those sections, each starting with its marker line.",
  ].join("\n");
}

export function revisionPrompt(input: RevisionPromptInput): string {
  const document = input.current
    .map((item) => `${SECTION_MARKER}${item.id}\n## ${item.title}\n${item.body || "(empty)"}`)
    .join("\n\n");
  const instruction =
    input.instruction ?? "Rewrite these sections so they match the current decision ledger. Keep whatever still holds.";
  return [
    contextBlock(input),
    `Current document:\n${document}`,
    `Sections to rewrite:\n${sectionList(input, input.targetIds)}`,
    `Instruction: ${instruction}`,
  ].join("\n\n");
}
