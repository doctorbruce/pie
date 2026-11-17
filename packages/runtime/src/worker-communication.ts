import type { WorkerEnqueueResult, WorkerMessage, WorkerMessageKind } from "./coordination.ts";
import type { Mode } from "./protocol.ts";

export type WorkerSendInput = {
	to: string;
	content: string;
	kind?: WorkerMessageKind;
	session_id?: string;
	reply_to?: string;
	new_session?: boolean;
};

export type WorkerCallContext = {
	workerId: string;
	sessionId: string;
	turnId: string;
	toolCallId: string;
	targets: readonly { assistantId: string; name: string; description: string }[];
	mode: Mode;
};

export type WorkerWaitOptions = { mode?: "sync" | "async"; timeoutMs?: number };

export type WorkerWaitRecord = {
	waitId: string;
	workerId: string;
	sessionId: string;
	turnId: string;
	toolCallId: string;
	messageId: string;
	mode?: "sync" | "async";
	status: "waiting" | "ready" | "cancelled" | "timed_out";
	createdAt: number;
	updatedAt: number;
};

export type WorkerWaitResult = {
	wait: WorkerWaitRecord;
	messages: WorkerMessage[];
	/** A sync wait returned control; the request remains active and inbox input is admitted before sampling. */
	reason?: "interval" | "message";
	/** Reserved responses; Runtime commits these with the matching tool result. */
	receipts?: readonly { deliveryId: string; messageId: string }[];
};

/** Durable communication facts required when a host supplies Worker communication. */
export interface WorkerCommunicationStore {
	registerWorkerWait(
		context: WorkerCallContext,
		messageId: string,
		waitId: string,
		options?: WorkerWaitOptions,
	): Promise<WorkerWaitResult>;
	finishWorkerWait(
		context: WorkerCallContext,
		waitId: string,
		status: "timed_out" | "cancelled",
	): Promise<WorkerWaitResult>;
	isWorkerDeliveryClaimed(deliveryId: string): Promise<boolean>;
	cancelWorkerTurn(sessionId: string, turnId: string): Promise<void>;
	isWorkerTurnCancelled(sessionId: string, turnId: string): Promise<boolean>;
	isWorkerMessageCancelled(messageId: string): Promise<boolean>;
	recordWorkerTurnCutoff(sessionId: string, turnId: string, workerId: string, sequence: number): Promise<number>;
	readWorkerTurnCutoff(sessionId: string): Promise<number>;
	listWorkerInputs(sessionId: string): Promise<WorkerEnqueueResult[]>;
}

export interface WorkerCommunication {
	send(context: WorkerCallContext, input: WorkerSendInput, signal?: AbortSignal): Promise<WorkerEnqueueResult>;
	wait(
		context: WorkerCallContext,
		messageId: string,
		signal?: AbortSignal,
		options?: WorkerWaitOptions,
	): Promise<WorkerWaitResult>;
	cancel(sessionId: string, turnId: string): Promise<void>;
	inputs(sessionId: string): Promise<WorkerEnqueueResult[]>;
}

export interface WorkerSessionCommunication {
	targets: readonly { assistantId: string; name: string; description: string }[];
	send(toolCallId: string, input: WorkerSendInput, signal?: AbortSignal): Promise<WorkerEnqueueResult>;
	wait(
		toolCallId: string,
		messageId: string,
		signal?: AbortSignal,
		options?: WorkerWaitOptions,
	): Promise<WorkerWaitResult>;
}
