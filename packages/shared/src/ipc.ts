import { z } from "zod";
import { ConfigBundle, ExportConfigInput, ImportSummary } from "./config";
import {
  AdvanceStageInput,
  AnswerRoundInput,
  CreateProjectInput,
  DiscussionStage,
  ProjectDetail,
  UpdateDecisionInput,
} from "./discussion";
import {
  DocumentProgress,
  DocumentView,
  GenerateDocumentInput,
  GetDocumentInput,
  RestoreDocumentInput,
  ReviseSectionsInput,
  SaveSectionInput,
} from "./documents";
import { ProjectPath, ProjectSummary } from "./domain";
import type { AppErrorShape } from "./errors";
import {
  AppNotice,
  BrowseInput,
  FolderAnswer,
  FolderListing,
  FolderRequest,
  ReadFileInput,
  ReadFileResult,
  SaveFileInput,
  SaveFileResult,
} from "./files";
import { HandoffPackage, HandoffTarget } from "./handoff";
import { ConnectionTestResult, LlmProfile, LlmProfileInput, RoleAssignment } from "./llm";
import { RepoScan, ScanRepoInput } from "./repo";
import { SearchService, SearchServiceInput, SearchTestResult } from "./research";
import {
  AgentConfig,
  MoveAgentInput,
  OverrideTaskInput,
  RoutingPlan,
  RoutingRules,
  RoutingRulesState,
  TaskRef,
  UpdateAgentInput,
} from "./routing";
import { RunnerOverrideInput, RunnerRun, RunnerRunRef } from "./runner";
import { AppInfo, Preferences } from "./settings";

interface ChannelSpec<I extends z.ZodType, O extends z.ZodType> {
  input: I;
  output: O;
}

function channel<I extends z.ZodType, O extends z.ZodType>(input: I, output: O): ChannelSpec<I, O> {
  return { input, output };
}

const Id = z.object({ id: z.number().int().positive() });

/**
 * Every renderer → main call. The main process validates `input` before a handler runs;
 * handlers return `output`. Adding a channel here is the only way to expose a capability.
 */
export const ipcContract = {
  "app.info": channel(z.void(), AppInfo),

  "settings.profiles.list": channel(z.void(), z.array(LlmProfile)),
  "settings.profiles.create": channel(LlmProfileInput, LlmProfile),
  "settings.profiles.update": channel(Id.extend({ data: LlmProfileInput }), LlmProfile),
  "settings.profiles.delete": channel(Id, z.void()),
  "settings.profiles.test": channel(Id, ConnectionTestResult),
  "settings.roles.get": channel(z.void(), RoleAssignment),
  "settings.roles.set": channel(RoleAssignment, RoleAssignment),
  "settings.preferences.get": channel(z.void(), Preferences),
  "settings.preferences.set": channel(Preferences.partial(), Preferences),
  "settings.agents.list": channel(z.void(), z.array(AgentConfig)),
  "settings.agents.update": channel(UpdateAgentInput, z.array(AgentConfig)),
  "settings.agents.move": channel(MoveAgentInput, z.array(AgentConfig)),
  "settings.routingRules.get": channel(z.void(), RoutingRulesState),
  /** null goes back to KM0's default rules. */
  "settings.routingRules.set": channel(RoutingRules.nullable(), RoutingRulesState),
  "settings.search.list": channel(z.void(), z.array(SearchService)),
  "settings.search.create": channel(SearchServiceInput, SearchService),
  "settings.search.update": channel(Id.extend({ data: SearchServiceInput }), SearchService),
  "settings.search.delete": channel(Id, z.void()),
  "settings.search.test": channel(Id.extend({ query: z.string().trim().min(1).max(200) }), SearchTestResult),
  "settings.export": channel(ExportConfigInput, ConfigBundle),
  "settings.import": channel(ConfigBundle, ImportSummary),

  /** Ask the user for a folder; null when they cancel. Desktop: a path. Web: a label for the picked folder. */
  "repo.pick": channel(z.void(), z.string().nullable()),

  // Desktop only: KM0 draws its own file browser instead of opening the system's dialogs.
  "files.browse": channel(BrowseInput, FolderListing),
  "files.read": channel(ReadFileInput, ReadFileResult),
  "files.save": channel(SaveFileInput, SaveFileResult),
  /** Show a saved file in the system's file manager. */
  "files.reveal": channel(ReadFileInput, z.void()),
  /** The user's answer to a `folder.request` event. */
  "folder.answer": channel(FolderAnswer, z.void()),
  "repo.scan": channel(ScanRepoInput, RepoScan),

  "project.list": channel(z.void(), z.array(ProjectSummary)),
  "project.create": channel(CreateProjectInput, ProjectDetail),
  "project.get": channel(Id, ProjectDetail),
  "project.rename": channel(Id.extend({ title: z.string().trim().min(1).max(120) }), ProjectSummary),
  "project.delete": channel(Id, z.void()),
  "project.setPath": channel(Id.extend({ path: ProjectPath }), ProjectDetail),
  "project.retry": channel(Id, ProjectDetail),

  "round.answer": channel(AnswerRoundInput, ProjectDetail),
  "stage.advance": channel(AdvanceStageInput, ProjectDetail),
  "stage.more": channel(z.object({ projectId: z.number().int().positive() }), ProjectDetail),
  "stage.review": channel(z.object({ projectId: z.number().int().positive(), stage: DiscussionStage }), ProjectDetail),
  "decision.update": channel(UpdateDecisionInput, ProjectDetail),

  "document.get": channel(GetDocumentInput, DocumentView.nullable()),
  "document.generate": channel(GenerateDocumentInput, DocumentView),
  "document.saveSection": channel(SaveSectionInput, DocumentView),
  "document.revise": channel(ReviseSectionsInput, DocumentView),
  "document.restore": channel(RestoreDocumentInput, DocumentView),

  "routing.get": channel(z.object({ projectId: z.number().int().positive() }), RoutingPlan.nullable()),
  "routing.plan": channel(z.object({ projectId: z.number().int().positive() }), RoutingPlan),
  "task.override": channel(OverrideTaskInput, RoutingPlan),
  /** Record one run of the task that did not pass its tests or acceptance criteria. */
  "task.fail": channel(TaskRef, RoutingPlan),
  "task.clearFailures": channel(TaskRef, RoutingPlan),

  "handoff.build": channel(
    z.object({ projectId: z.number().int().positive(), target: HandoffTarget.default("agents") }),
    HandoffPackage,
  ),

  /** Pick a KM0 Runner run directory and read its reports into the project. */
  "runner.import": channel(z.object({ projectId: z.number().int().positive() }), RunnerRun.nullable()),
  "runner.list": channel(z.object({ projectId: z.number().int().positive() }), z.array(RunnerRun)),
  /** Judge every task of a run that has no verdict yet against its acceptance criteria. */
  "runner.judge": channel(RunnerRunRef, RunnerRun),
  "runner.override": channel(RunnerOverrideInput, RunnerRun),
  /** Write acceptance.jsonl to the run directory again, after choosing the folder anew. */
  "runner.writeBack": channel(RunnerRunRef, RunnerRun),
} as const;

export type IpcContract = typeof ipcContract;
export type IpcChannel = keyof IpcContract;
export type IpcInput<C extends IpcChannel> = z.input<IpcContract[C]["input"]>;
export type IpcOutput<C extends IpcChannel> = z.output<IpcContract[C]["output"]>;

export type IpcResult<T> = { ok: true; data: T } | { ok: false; error: AppErrorShape };

/** main → renderer push events. */
export const ipcEvents = {
  "document.progress": DocumentProgress,
  "folder.request": FolderRequest,
  "app.notice": AppNotice,
} as const;

export type IpcEvents = typeof ipcEvents;
export type IpcEvent = keyof IpcEvents;
export type IpcEventPayload<E extends IpcEvent> = z.output<IpcEvents[E]>;
export type EmitEvent = <E extends IpcEvent>(event: E, payload: IpcEventPayload<E>) => void;

export { IPC_EVENT, IPC_INVOKE } from "./bridge";

/** API exposed on `window.km0` by the preload script. */
export interface Km0Bridge {
  invoke<C extends IpcChannel>(channel: C, input: IpcInput<C>): Promise<IpcResult<IpcOutput<C>>>;
  /** Subscribe to a push event; returns the unsubscribe function. */
  on<E extends IpcEvent>(event: E, listener: (payload: IpcEventPayload<E>) => void): () => void;
}
