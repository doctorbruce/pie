import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ActivityRecord,
	Assistant,
	ContextCompaction,
	RuntimeConfig,
	SessionSummary,
	TransferMessage,
} from "./protocol.ts";
import type { MessageTree } from "./session-tree.ts";

export type SavedSession = SessionSummary & {
	astronSessionId?: string;
	assistant?: Assistant;
	revision: number;
	messages: AgentMessage[];
	tree?: MessageTree;
	runtime?: RuntimeConfig;
	activities?: ActivityRecord[];
	compaction?: ContextCompaction;
	transferBase?: TransferMessage[];
	transferBaseMessageCount?: number;
};

export type SessionMetadata = Omit<SavedSession, "messages" | "tree" | "transferBase"> & { leafId: string | null };

export interface RuntimeStore {
	readonly persistence: string;
	loadSessions(): Promise<SessionMetadata[]>;
	saveSession(session: SavedSession, replaceHistory?: boolean): Promise<SessionMetadata>;
	readPath(id: string, leafId?: string | null): Promise<MessageTree>;
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
