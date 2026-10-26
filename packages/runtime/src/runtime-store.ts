import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { DurableJobReference } from "./durable-jobs.ts";
import type {
	ActivityRecord,
	Assistant,
	ContextCompaction,
	RuntimeConfig,
	SessionSummary,
	TransferMessage,
} from "./protocol.ts";
import type { MessageTree } from "./session-tree.ts";
import type { ToolExecutionPage, ToolExecutionReadOptions, ToolExecutionRecord } from "./tool-execution.ts";

export type TurnCheckpoint = {
	version: 1;
	turnId: string;
	inputEntryId: string;
	systemPrompt: string;
	blockedReason?: string;
	cancelRequested?: boolean;
	jobs?: DurableJobReference[];
	pendingAssistant?: Extract<AgentMessage, { role: "assistant" }>;
};

export type SavedSession = SessionSummary & {
	astronSessionId?: string;
	assistant?: Assistant;
	revision: number;
	messages: AgentMessage[];
	tree?: MessageTree;
	runtime?: RuntimeConfig;
	activities?: ActivityRecord[];
	compaction?: ContextCompaction;
	turnCheckpoint?: TurnCheckpoint;
	transferBase?: TransferMessage[];
	transferBaseMessageCount?: number;
};

export type SessionMetadata = Omit<SavedSession, "messages" | "tree" | "transferBase"> & { leafId: string | null };

export type SessionCursor = { updatedAt: number; id: string };
export type SessionListOptions = {
	limit: number;
	cursor?: SessionCursor;
	assistantId?: string;
	kind?: SessionSummary["kind"];
	parentSessionId?: string;
};
export type SessionPage = { sessions: SessionMetadata[]; nextCursor: SessionCursor | null };

export interface RuntimeStore {
	readonly persistence: string;
	readSession(id: string): Promise<SessionMetadata | undefined>;
	listSessions(options: SessionListOptions): Promise<SessionPage>;
	saveSession(
		session: SavedSession,
		replaceHistory?: boolean,
		toolExecutions?: readonly ToolExecutionRecord[],
	): Promise<SessionMetadata>;
	readToolExecutions(id: string, options: ToolExecutionReadOptions): Promise<ToolExecutionPage>;
	readPath(id: string, leafId?: string | null): Promise<MessageTree>;
	readTurnPath(id: string, inputEntryId: string, leafId?: string | null): Promise<MessageTree>;
	readPathIds(id: string, leafId?: string | null): Promise<string[]>;
	readWorkingPath(id: string, compaction?: ContextCompaction): Promise<MessageTree>;
	readTree(id: string): Promise<MessageTree>;
	readHistory(
		id: string,
		options: { limit: number; beforeSeq?: number; leafId?: string | null },
	): Promise<{ entries: MessageTree["nodes"]; nextBeforeSeq: number | null }>;
	deleteSession(id: string): Promise<void>;
	close(): Promise<void>;
}
