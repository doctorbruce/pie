// Wire types are independent of both the model SDK and the frontend framework.
export type TextPart = { type: "text"; text: string };
export type ImagePart = { type: "image"; data: string; mimeType: string };
export type WireMessage =
	| { role: "user"; content: string | (TextPart | ImagePart)[]; timestamp: number }
	| {
			role: "assistant";
			content: (
				| TextPart
				| { type: "thinking"; thinking: string }
				| {
						type: "toolCall";
						id: string;
						name: string;
						arguments: Record<string, unknown>;
						argumentsText?: string;
				  }
			)[];
			stopReason: string;
			errorMessage?: string;
			usage?: {
				input: number;
				output: number;
				reasoning?: number;
				cacheRead: number;
				cacheWrite: number;
				totalTokens: number;
				cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
			};
			timestamp: number;
	  }
	| {
			role: "toolResult";
			toolCallId: string;
			toolName: string;
			content: (TextPart | ImagePart)[];
			isError: boolean;
			details?: unknown;
			timestamp: number;
	  };

export type Mode = "faux" | "real";
export type ToolId = string;
export type ToolInfo = { id: ToolId; label: string };
export type SkillSource = {
	pluginId: string;
	pluginName: string;
	pluginVersion?: string;
};
export type Skill = { id: string; name: string; description: string; path: string; source: SkillSource };
export type SkillBinding = {
	id: string;
	name: string;
	description: string;
	descriptions?: Record<string, string>;
	directory: string;
	resourceRoot?: string;
	source?: SkillSource;
};
export type PermissionDecision = "allow" | "ask";
export type PermissionPolicy = Record<string, PermissionDecision>;
export type McpServerConfig =
	| {
			type: "local";
			command: string[];
			environment?: Record<string, string>;
			cwd?: string;
			enabled?: boolean;
			timeout?: number;
	  }
	| {
			type: "remote";
			url: string;
			headers?: Record<string, string>;
			oauth?: false | { clientId?: string; clientSecret?: string; scope?: string };
			enabled?: boolean;
			timeout?: number;
	  };
export type AgentRuntimeConfig = {
	compaction?: { thresholdTokens?: number };
	mcp?: Record<string, McpServerConfig>;
	systemPrompt: string;
	language?: string;
	toolIds: ToolId[];
	skills: SkillBinding[];
	permissions?: PermissionPolicy;
};
export type HostSubagentBinding = {
	id: string;
	name: string;
	description: string;
	assistantId: string;
	model?: ModelSelection;
};
export type HostRuntimeConfig = AgentRuntimeConfig & { subagents: HostSubagentBinding[] };
export type HostRuntimeDefinition = {
	assistantId: string;
	assistantRevision: string;
	runtime: HostRuntimeConfig;
};
export type SubagentBinding = {
	id: string;
	name: string;
	description: string;
	assistantId: string;
	assistantRevision?: string;
	runtime: AgentRuntimeConfig;
	model?: ModelSelection;
};
export type RuntimeConfig = AgentRuntimeConfig & { subagents: SubagentBinding[] };
export type RuntimeSource = "local" | "host";
export type ToolActivity = {
	id: string;
	toolCallId: string;
	kind: "skill_load";
	binding: SkillBinding;
	status: "running" | "succeeded" | "failed" | "cancelled" | "unknown";
	startedAt: number;
	finishedAt?: number;
	contentHash?: string;
	error?: string;
};
export type ActivityRecord = ToolActivity & { sessionId: string; turnId: string };
export type Plugin = { id: string; name: string; summary: string; skills: Skill[] };
export type Assistant = {
	id: string;
	name: string;
	systemPrompt: string;
	toolIds: ToolId[];
	pluginIds: string[];
	subagentIds: string[];
	createdAt: number;
	updatedAt: number;
};
export type SessionSummary = {
	id: string;
	kind: "root" | "subagent";
	forkedFromSessionId?: string;
	parentSessionId?: string;
	parentToolCallId?: string;
	subagentType?: string;
	assistantId: string;
	assistantRevision?: string;
	runtimeSource: RuntimeSource;
	title: string;
	workspacePath?: string;
	mode: Mode;
	model: string;
	provider?: string;
	modelOverride?: { providerId: string; model: string } | null;
	createdAt: number;
	updatedAt: number;
	turn?: Turn;
};
export type ModelSelection = { provider: string; id: string };
export type ProviderModel = { id: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean };
export type ProviderSettings = {
	id: string;
	name: string;
	api: string;
	baseUrl: string;
	keyConfigured: boolean;
	models: ProviderModel[];
};
export type ProviderCatalog = { selected?: ModelSelection; providers: ProviderSettings[] };
export type ModelCatalog = {
	selected?: ModelSelection;
	models: (ModelSelection & {
		name: string;
		api: string;
		baseUrl: string;
		contextWindow: number;
		maxTokens: number;
		reasoning: boolean;
		keyConfigured: boolean;
	})[];
};
export type Turn = {
	id: string;
	requestId?: string;
	status: "running" | "completed" | "cancelled" | "failed";
	error?: string;
};
export type ContextCompaction = {
	summary: string;
	firstKeptMessage: number;
	firstKeptEntryId?: string;
	turnStartEntryId?: string;
	workingMessageCount?: number;
	loadedToolNames?: string[];
	turnStartIndex?: number;
	messageCount?: number;
	details?: { readFiles: string[]; modifiedFiles: string[] };
	usage?: Extract<WireMessage, { role: "assistant" }>["usage"];
	tokensBefore: number;
	estimatedTokensAfter: number;
	compactedAt: number;
	generation: number;
};
export type InteractionRequest = {
	id: string;
	type: "confirmation";
	title: string;
	message: string;
	metadata?: Record<string, unknown>;
};
export type SessionSnapshot = SessionSummary & {
	instanceId: string;
	assistant?: Assistant;
	revision: number;
	messages: WireMessage[];
	streamingMessage?: WireMessage;
	turn?: Turn;
	runtime?: RuntimeConfig;
	activities?: ActivityRecord[];
	compaction?: ContextCompaction;
	interactions: InteractionRequest[];
	history?: { leafId: string | null; nextBeforeSeq: number | null };
};
export type SessionState = Omit<SessionSnapshot, "messages" | "history">;
export type SessionHistoryPage = {
	instanceId: string;
	revision: number;
	leafId: string | null;
	entries: { id: string; parentId: string | null; seq?: number; message: WireMessage }[];
	nextBeforeSeq: number | null;
};
export type SessionForkResult = {
	session: SessionSnapshot;
	selectedText: string;
};
export type SessionTree = {
	leafId: string | null;
	entries: {
		id: string;
		parentId: string | null;
		messageId: string;
		role: string;
		text: string;
		active: boolean;
		selectable: boolean;
	}[];
};
export type TransferContentPart = { type: string; [key: string]: unknown };
export type TransferMessage = {
	id?: string;
	role: "user" | "assistant" | "system";
	content: TransferContentPart[];
	metadata?: Record<string, unknown>;
	stopReason?: string;
	errorMessage?: string;
	createdAt?: number;
};
export type SessionTransfer = {
	schemaVersion: 1;
	modelOverride?: SessionSummary["modelOverride"];
	source: {
		astronSessionId: string;
		coreId: string;
		sessionId: string;
	};
	title?: string;
	workspacePath?: string;
	persona?: string;
	transcript: TransferMessage[];
	createdAt?: number;
	updatedAt?: number;
};
export type SessionEvent = {
	type:
		| "snapshot"
		| "agent.event"
		| "turn.settled"
		| "activity.updated"
		| "compaction.updated"
		| "compaction.started"
		| "compaction.finished"
		| "compaction.retry"
		| "interaction.requested"
		| "interaction.resolved";
	sessionId: string;
	turnId?: string;
	instanceId: string;
	revision: number;
	turn?: Turn;
	event?: { type: string; [key: string]: unknown };
	activity?: ActivityRecord;
	interaction?: InteractionRequest;
	state?: SessionState;
	snapshot?: SessionSnapshot;
};
export type MaterializedSessionEvent = Omit<SessionEvent, "snapshot"> & { snapshot: SessionSnapshot };
export type GlobalSessionEvent = Pick<
	SessionEvent,
	"type" | "sessionId" | "turnId" | "event" | "activity" | "interaction"
> & {
	snapshot: Pick<SessionSnapshot, "instanceId" | "revision" | "turn">;
};
export type ServerInfo = {
	protocolVersion: 1;
	coreId: "pie";
	persistence: string;
	realModel?: { provider: string; id: string };
	realModelError?: string;
};
