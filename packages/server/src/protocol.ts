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
				  }
			)[];
			stopReason: string;
			errorMessage?: string;
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
	directory: string;
	resourceRoot?: string;
	source?: SkillSource;
};
export type PermissionDecision = "allow" | "ask";
export type PermissionPolicy = Record<string, PermissionDecision>;
export type AgentRuntimeConfig = {
	systemPrompt: string;
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
	status: "running" | "completed" | "cancelled" | "failed";
	error?: string;
};
export type ContextCompaction = {
	summary: string;
	firstKeptMessage: number;
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
};
export type SessionForkResult = {
	session: SessionSnapshot;
	selectedText: string;
};
export type TransferContentPart = { type: string; [key: string]: unknown };
export type TransferMessage = {
	id?: string;
	role: "user" | "assistant" | "system";
	content: TransferContentPart[];
	metadata?: Record<string, unknown>;
	createdAt?: number;
};
export type SessionTransfer = {
	schemaVersion: 1;
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
		| "interaction.requested"
		| "interaction.resolved";
	sessionId: string;
	turnId?: string;
	event?: { type: string; [key: string]: unknown };
	activity?: ActivityRecord;
	interaction?: InteractionRequest;
	snapshot: SessionSnapshot;
};
export type ServerInfo = {
	protocolVersion: 1;
	coreId: "pie";
	persistence: "sqlite";
	realModel?: { provider: string; id: string };
	realModelError?: string;
};
