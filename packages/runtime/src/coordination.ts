import { randomUUID } from "node:crypto";

export type InputBatchStatus = "pending" | "accepted" | "consumed" | "failed";
export type InputBatch = {
	batchId: string;
	sessionId: string;
	inputId: string;
	content: string;
	requestFingerprint: string;
	status: InputBatchStatus;
	createdAt: number;
	acceptedTurnId?: string;
	consumedAt?: number;
	error?: string;
};

export type InputBatchCreate = {
	batchId?: string;
	sessionId: string;
	inputId?: string;
	content: string;
	requestFingerprint?: string;
};

export type YieldRecord = {
	yieldId: string;
	sessionId: string;
	turnId: string;
	reason: "waiting_for_message" | "paused";
	checkpoint: Record<string, unknown>;
	createdAt: number;
	status: "yielded" | "resumed";
};

export interface CoordinationStore {
	createInputBatch(batch: InputBatch): Promise<InputBatch>;
	readInputBatch(batchId: string): Promise<InputBatch | undefined>;
	updateInputBatch(
		batchId: string,
		update: Partial<Pick<InputBatch, "status" | "acceptedTurnId" | "consumedAt" | "error">>,
	): Promise<InputBatch>;
	createYield(record: YieldRecord): Promise<YieldRecord>;
	readYield(yieldId: string): Promise<YieldRecord | undefined>;
}

export class CoordinationError extends Error {
	readonly status: number;
	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

function fingerprint(input: InputBatchCreate) {
	return input.requestFingerprint ?? JSON.stringify({ sessionId: input.sessionId, content: input.content });
}

export class CoordinationService {
	private readonly store: CoordinationStore;

	constructor(store: CoordinationStore) {
		this.store = store;
	}

	readInputBatch(batchId: string) {
		return this.store.readInputBatch(batchId);
	}

	readYield(yieldId: string) {
		return this.store.readYield(yieldId);
	}

	async createInputBatch(input: InputBatchCreate): Promise<InputBatch> {
		if (!input.sessionId.trim() || !input.content.trim())
			throw new CoordinationError(400, "输入批次需要 sessionId 和非空 content");
		if (input.content.length > 16000) throw new CoordinationError(400, "输入批次 content 最多 16000 个字符");
		const batch: InputBatch = {
			batchId: input.batchId?.trim() || randomUUID(),
			sessionId: input.sessionId,
			inputId: input.inputId?.trim() || randomUUID(),
			content: input.content,
			requestFingerprint: fingerprint(input),
			status: "pending",
			createdAt: Date.now(),
		};
		try {
			return await this.store.createInputBatch(batch);
		} catch (error) {
			if (error instanceof CoordinationError) throw error;
			throw new CoordinationError(503, "输入批次保存失败，未启动模型执行");
		}
	}

	async acceptInputBatch(batchId: string, turnId: string): Promise<InputBatch> {
		const current = await this.store.readInputBatch(batchId);
		if (!current) throw new CoordinationError(404, "输入批次不存在");
		if (current.status === "accepted" || current.status === "consumed") {
			if (current.acceptedTurnId !== turnId) throw new CoordinationError(409, "输入批次已被其他 Turn 接纳");
			return current;
		}
		if (current.status !== "pending") throw new CoordinationError(409, "输入批次已失败，不能接纳");
		return this.store.updateInputBatch(batchId, { status: "accepted", acceptedTurnId: turnId });
	}

	async consumeInputBatch(batchId: string, turnId: string): Promise<InputBatch> {
		const current = await this.store.readInputBatch(batchId);
		if (!current) throw new CoordinationError(404, "输入批次不存在");
		if (current.acceptedTurnId !== turnId) throw new CoordinationError(409, "输入批次不属于当前 Turn");
		if (current.status === "consumed") return current;
		if (current.status !== "accepted") throw new CoordinationError(409, "输入批次尚未接纳");
		return this.store.updateInputBatch(batchId, { status: "consumed", consumedAt: Date.now() });
	}

	async yieldTurn(input: Omit<YieldRecord, "yieldId" | "createdAt" | "status"> & { yieldId?: string }) {
		if (!input.sessionId.trim() || !input.turnId.trim())
			throw new CoordinationError(400, "让出记录需要 sessionId 和 turnId");
		return this.store.createYield({
			...input,
			yieldId: input.yieldId?.trim() || randomUUID(),
			createdAt: Date.now(),
			status: "yielded",
		});
	}
}
