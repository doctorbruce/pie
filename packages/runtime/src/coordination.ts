import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Mode, ModelSelection } from "./protocol.ts";

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

/** A value supplied by the host to identify the product-side binding. */
export type WorkerProductBinding = string | Record<string, unknown>;
export type WorkerModelSelection = ModelSelection;

export type WorkerStatus = "active" | "paused" | "stopped";
export type WorkItemStatus = "pending" | "active" | "completed" | "failed" | "stopped";
export type AssignmentStatus = "pending" | "active" | "completed" | "stopped";
export type WorkerMessageKind = "request" | "question" | "reply" | "progress" | "result";
export type WorkerMessageStatus = "queued" | "resolved" | "dispatched" | "failed";
export type WorkerDeliveryStatus = "pending" | "resolved" | "dispatched" | "accepted" | "consumed" | "failed";

export type WorkerRecord = {
	workerId: string;
	assistantId: string;
	assistantRevision?: string | number;
	status: WorkerStatus;
	productBinding?: WorkerProductBinding;
	defaultWorkspacePath?: string;
	defaultModel?: WorkerModelSelection;
	createdAt: number;
	updatedAt: number;
};

export type WorkerRegistration = Omit<WorkerRecord, "workerId" | "status" | "createdAt" | "updatedAt"> & {
	workerId?: string;
	status?: WorkerStatus;
	createdAt?: number;
	updatedAt?: number;
};

export type WorkItem = {
	workId: string;
	title: string;
	status: WorkItemStatus;
	goal?: string;
	sourceWorkerId?: string;
	sourceSessionId?: string;
	authorizationScope?: WorkerProductBinding;
	result?: unknown;
	pendingQuestion?: string;
	createdAt: number;
	updatedAt: number;
};

export type WorkItemCreate = Omit<WorkItem, "workId" | "status" | "createdAt" | "updatedAt"> & {
	workId?: string;
	status?: WorkItemStatus;
	createdAt?: number;
	updatedAt?: number;
};

export type AssignmentRecord = {
	assignmentId: string;
	workId: string;
	workerId: string;
	sessionId: string;
	workspacePath?: string;
	model?: WorkerModelSelection;
	productBinding?: WorkerProductBinding;
	status: AssignmentStatus;
	createdAt: number;
	updatedAt?: number;
	creationKey?: string;
	stopRequested?: boolean;
};

/** Kept as a short alias for hosts that use the domain name without Record. */
export type Assignment = AssignmentRecord;

export type AssignmentCreate = Omit<AssignmentRecord, "assignmentId" | "status" | "createdAt"> & {
	assignmentId?: string;
	status?: AssignmentStatus;
	createdAt?: number;
};

export type WorkerMessage = {
	messageId: string;
	/** Target Worker. The source identity is carried separately and is trusted from execution context. */
	workerId: string;
	sourceWorkerId: string;
	sourceSessionId?: string;
	sourceTurnId?: string;
	workId?: string;
	targetSessionId?: string;
	replyTo?: string;
	kind: WorkerMessageKind;
	content: string;
	sequence: number;
	status: WorkerMessageStatus;
	createdAt: number;
	newSession?: boolean;
	workspacePath?: string;
	model?: WorkerModelSelection;
	productBinding?: WorkerProductBinding;
	title?: string;
	mode?: Mode;
	/** Optional stable delivery identity supplied by a host retry. */
	deliveryId?: string;
};

export type WorkerMessageCreate = Omit<WorkerMessage, "messageId" | "kind" | "sequence" | "status" | "createdAt"> & {
	messageId?: string;
	kind?: WorkerMessageKind;
};

export type WorkerDelivery = {
	deliveryId: string;
	messageId: string;
	workerId: string;
	assignmentId?: string;
	sessionId?: string;
	status: WorkerDeliveryStatus;
	error?: string;
	createdAt: number;
	updatedAt: number;
	acceptedTurnId?: string;
	consumedAt?: number;
};

export type WorkerDeliveryCreate = Omit<WorkerDelivery, "deliveryId" | "status" | "createdAt" | "updatedAt"> & {
	deliveryId?: string;
	status?: WorkerDeliveryStatus;
	createdAt?: number;
	updatedAt?: number;
};

export type WorkerEnqueueResult = {
	message: WorkerMessage;
	delivery: WorkerDelivery;
};

/**
 * Persistence facts used by the Worker scheduler. This is intentionally
 * separate from CoordinationStore so existing RuntimeStore implementations
 * remain valid until they opt into Worker coordination.
 */
export interface WorkerCoordinationStore {
	registerWorker(worker: WorkerRecord): Promise<WorkerRecord>;
	readWorker(workerId: string): Promise<WorkerRecord | undefined>;
	listWorkers(): Promise<WorkerRecord[]>;
	createWorkItem(workItem: WorkItem): Promise<WorkItem>;
	readWorkItem(workId: string): Promise<WorkItem | undefined>;
	findAssignmentByWork(workId: string): Promise<AssignmentRecord[]>;
	findAssignmentBySession(sessionId: string): Promise<AssignmentRecord | undefined>;
	createAssignment(assignment: AssignmentRecord): Promise<AssignmentRecord>;
	readWorkerMessage(messageId: string): Promise<WorkerMessage | undefined>;
	createWorkerMessage(message: WorkerMessage): Promise<WorkerMessage>;
	createWorkerDelivery(delivery: WorkerDelivery): Promise<WorkerDelivery>;
	readWorkerDelivery(deliveryId: string): Promise<WorkerDelivery | undefined>;
	updateWorkerDelivery(
		deliveryId: string,
		update: Partial<
			Pick<
				WorkerDelivery,
				"assignmentId" | "sessionId" | "status" | "error" | "updatedAt" | "acceptedTurnId" | "consumedAt"
			>
		>,
	): Promise<WorkerDelivery>;
	nextWorkerSequence(workerId: string): Promise<number>;
}

export type WorkerResolution = {
	workerId: string;
	workId?: string;
	assignmentId?: string;
	sessionId?: string;
	status: "resolved" | "pending";
	reason?: string;
};

function requiredCoordinationText(value: unknown, field: string, limit = 256): string {
	if (typeof value !== "string" || !value.trim() || value.length > limit)
		throw new CoordinationError(400, `${field} 需要 1–${limit} 个字符`);
	return value.trim();
}

function optionalCoordinationText(value: unknown, field: string, limit = 256): string | undefined {
	return value === undefined ? undefined : requiredCoordinationText(value, field, limit);
}

function coordinationChoice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
	if (typeof value !== "string" || !choices.includes(value as T))
		throw new CoordinationError(400, `${field} 取值无效`);
	return value as T;
}

function coordinationObject(value: unknown): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new CoordinationError(400, "协调输入需要对象");
}

function coordinationTimestamp(value: unknown, field: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
		throw new CoordinationError(400, `${field} 需要非负整数时间戳`);
	return value;
}

function coordinationModel(value: unknown): WorkerModelSelection | undefined {
	if (value === undefined) return undefined;
	coordinationObject(value);
	return {
		provider: requiredCoordinationText(value.provider, "model.provider"),
		id: requiredCoordinationText(value.id, "model.id"),
	};
}

function coordinationProductBinding(value: unknown): WorkerProductBinding | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") return requiredCoordinationText(value, "productBinding");
	coordinationObject(value);
	try {
		if (JSON.stringify(value).length > 16000) throw new Error("too large");
	} catch {
		throw new CoordinationError(400, "productBinding 需要最多 16000 个字符的 JSON 对象");
	}
	return value;
}

function workerMessageRequest(message: WorkerMessage | WorkerMessageCreate) {
	return {
		workerId: message.workerId,
		sourceWorkerId: message.sourceWorkerId,
		sourceSessionId: message.sourceSessionId,
		sourceTurnId: message.sourceTurnId,
		workId: message.workId,
		targetSessionId: message.targetSessionId,
		replyTo: message.replyTo,
		kind: message.kind ?? "request",
		content: message.content,
		newSession: message.newSession ?? false,
		workspacePath: message.workspacePath,
		model: message.model,
		productBinding: message.productBinding,
		title: message.title,
		mode: message.mode,
		deliveryId: message.deliveryId ?? `${message.messageId}:delivery`,
	};
}

/**
 * Deterministic Worker coordination. The service only validates and stores
 * durable facts; selecting a model or asking an LLM to disambiguate is owned
 * by the host scheduler.
 */
export class WorkerCoordinationService {
	private readonly store: WorkerCoordinationStore;

	constructor(store: WorkerCoordinationStore) {
		this.store = store;
	}

	readWorker(workerId: string) {
		return this.store.readWorker(workerId);
	}

	listWorkers() {
		return this.store.listWorkers();
	}

	readWorkItem(workId: string) {
		return this.store.readWorkItem(workId);
	}

	findAssignmentByWork(workId: string) {
		return this.store.findAssignmentByWork(workId);
	}

	findAssignmentBySession(sessionId: string) {
		return this.store.findAssignmentBySession(sessionId);
	}

	readWorkerMessage(messageId: string) {
		return this.store.readWorkerMessage(messageId);
	}

	readWorkerDelivery(deliveryId: string) {
		return this.store.readWorkerDelivery(deliveryId);
	}

	async registerWorker(input: WorkerRegistration | WorkerRecord): Promise<WorkerRecord> {
		coordinationObject(input);
		const assistantId = requiredCoordinationText(input.assistantId, "assistantId");
		const workerId = optionalCoordinationText(input.workerId, "workerId") ?? assistantId;
		const status = coordinationChoice(input.status ?? "active", ["active", "paused", "stopped"] as const, "status");
		if (
			input.assistantRevision !== undefined &&
			(typeof input.assistantRevision !== "string" ||
				!input.assistantRevision.trim() ||
				input.assistantRevision.length > 256) &&
			(typeof input.assistantRevision !== "number" || !Number.isSafeInteger(input.assistantRevision))
		)
			throw new CoordinationError(400, "assistantRevision 需要非空字符串或整数");
		const productBinding = coordinationProductBinding(input.productBinding);
		const defaultWorkspacePath = optionalCoordinationText(input.defaultWorkspacePath, "defaultWorkspacePath", 4096);
		const defaultModel = coordinationModel(input.defaultModel);
		const createdAt = coordinationTimestamp(input.createdAt, "createdAt");
		const updatedAt = coordinationTimestamp(input.updatedAt, "updatedAt");
		const existing = await this.store.readWorker(workerId);
		if (existing) {
			if (existing.assistantId !== assistantId) throw new CoordinationError(409, "workerId 已绑定其他 assistant");
		}
		if (
			(await this.store.listWorkers()).some(
				(worker) => worker.assistantId === assistantId && worker.workerId !== workerId,
			)
		)
			throw new CoordinationError(409, "assistantId 已注册其他逻辑 Worker");
		const now = Date.now();
		const worker: WorkerRecord = {
			workerId,
			assistantId,
			...(input.assistantRevision === undefined ? {} : { assistantRevision: input.assistantRevision }),
			status,
			...(productBinding === undefined ? {} : { productBinding }),
			...(defaultWorkspacePath === undefined ? {} : { defaultWorkspacePath }),
			...(defaultModel === undefined ? {} : { defaultModel }),
			createdAt: existing?.createdAt ?? createdAt ?? now,
			updatedAt: updatedAt ?? now,
		};
		try {
			return await this.store.registerWorker(worker);
		} catch (error) {
			if (error instanceof CoordinationError) throw error;
			throw new CoordinationError(503, "Worker 保存失败");
		}
	}

	async createWorkItem(input: WorkItemCreate | WorkItem): Promise<WorkItem> {
		coordinationObject(input);
		const title = requiredCoordinationText(input.title, "工作项 title", 100);
		const workId = optionalCoordinationText(input.workId, "workId") ?? randomUUID();
		const status = coordinationChoice(
			input.status ?? "pending",
			["pending", "active", "completed", "failed", "stopped"] as const,
			"status",
		);
		const goal = optionalCoordinationText(input.goal, "goal", 16000);
		const sourceWorkerId = optionalCoordinationText(input.sourceWorkerId, "sourceWorkerId");
		const sourceSessionId = optionalCoordinationText(input.sourceSessionId, "sourceSessionId");
		const authorizationScope = coordinationProductBinding(input.authorizationScope);
		const pendingQuestion = optionalCoordinationText(input.pendingQuestion, "pendingQuestion", 16000);
		const createdAt = coordinationTimestamp(input.createdAt, "createdAt");
		const updatedAt = coordinationTimestamp(input.updatedAt, "updatedAt");
		const existing = await this.store.readWorkItem(workId);
		if (existing) {
			if (
				!isDeepStrictEqual(
					{
						title: existing.title,
						goal: existing.goal,
						sourceWorkerId: existing.sourceWorkerId,
						sourceSessionId: existing.sourceSessionId,
						authorizationScope: existing.authorizationScope,
					},
					{
						title,
						goal,
						sourceWorkerId,
						sourceSessionId,
						authorizationScope,
					},
				)
			)
				throw new CoordinationError(409, "workId 已绑定其他工作项");
			return existing;
		}
		const now = Date.now();
		const workItem: WorkItem = {
			workId,
			title,
			status,
			...(goal === undefined ? {} : { goal }),
			...(sourceWorkerId === undefined ? {} : { sourceWorkerId }),
			...(sourceSessionId === undefined ? {} : { sourceSessionId }),
			...(authorizationScope === undefined ? {} : { authorizationScope }),
			...(input.result === undefined ? {} : { result: input.result }),
			...(pendingQuestion === undefined ? {} : { pendingQuestion }),
			createdAt: createdAt ?? now,
			updatedAt: updatedAt ?? now,
		};
		try {
			return await this.store.createWorkItem(workItem);
		} catch (error) {
			if (error instanceof CoordinationError) throw error;
			throw new CoordinationError(503, "工作项保存失败");
		}
	}

	async createAssignment(input: AssignmentCreate | AssignmentRecord): Promise<AssignmentRecord> {
		coordinationObject(input);
		const workId = requiredCoordinationText(input.workId, "workId");
		const workerId = requiredCoordinationText(input.workerId, "workerId");
		const sessionId = requiredCoordinationText(input.sessionId, "sessionId");
		const assignmentId = optionalCoordinationText(input.assignmentId, "assignmentId") ?? randomUUID();
		const status = coordinationChoice(
			input.status ?? "active",
			["pending", "active", "completed", "stopped"] as const,
			"status",
		);
		const workspacePath = optionalCoordinationText(input.workspacePath, "workspacePath", 4096);
		const model = coordinationModel(input.model);
		const productBinding = coordinationProductBinding(input.productBinding);
		const creationKey = optionalCoordinationText(input.creationKey, "creationKey");
		const createdAt = coordinationTimestamp(input.createdAt, "createdAt");
		const updatedAt = coordinationTimestamp(input.updatedAt, "updatedAt");
		if (input.stopRequested !== undefined && typeof input.stopRequested !== "boolean")
			throw new CoordinationError(400, "stopRequested 需要布尔值");
		if (!(await this.store.readWorkItem(workId))) throw new CoordinationError(404, "工作项不存在");
		if (!(await this.store.readWorker(workerId))) throw new CoordinationError(404, "Worker 不存在");
		const existingForSession = await this.store.findAssignmentBySession(sessionId);
		if (existingForSession) {
			if (existingForSession.workId !== workId || existingForSession.workerId !== workerId)
				throw new CoordinationError(409, "Session 已关联其他 Worker 工作项");
			if (
				(input.assignmentId !== undefined && existingForSession.assignmentId !== assignmentId) ||
				!isDeepStrictEqual(
					{
						workspacePath: existingForSession.workspacePath,
						model: existingForSession.model,
						productBinding: existingForSession.productBinding,
						creationKey: existingForSession.creationKey,
					},
					{ workspacePath, model, productBinding, creationKey },
				)
			)
				throw new CoordinationError(409, "Session 已使用不同工作会话关联参数");
			return existingForSession;
		}
		const now = Date.now();
		const assignment: AssignmentRecord = {
			assignmentId,
			workId,
			workerId,
			sessionId,
			...(workspacePath === undefined ? {} : { workspacePath }),
			...(model === undefined ? {} : { model }),
			...(productBinding === undefined ? {} : { productBinding }),
			status,
			createdAt: createdAt ?? now,
			...(updatedAt === undefined ? {} : { updatedAt }),
			...(creationKey === undefined ? {} : { creationKey }),
			...(input.stopRequested === undefined ? {} : { stopRequested: input.stopRequested }),
		};
		try {
			return await this.store.createAssignment(assignment);
		} catch (error) {
			if (error instanceof CoordinationError) throw error;
			throw new CoordinationError(503, "工作会话关联保存失败");
		}
	}

	private async resolveFact(message: WorkerMessage, delivery?: WorkerDelivery): Promise<WorkerResolution> {
		const worker = await this.store.readWorker(message.workerId);
		if (!worker) throw new CoordinationError(404, "目标 Worker 不存在");
		if (worker.status !== "active")
			return {
				workerId: message.workerId,
				workId: message.workId,
				status: "pending",
				reason: "目标 Worker 已暂停或停止",
			};
		let workId = message.workId;
		let sessionId = message.targetSessionId;
		if (message.newSession && (delivery?.sessionId || delivery?.assignmentId)) {
			const binding = delivery.sessionId ? await this.store.findAssignmentBySession(delivery.sessionId) : undefined;
			if (
				!binding ||
				binding.assignmentId !== delivery.assignmentId ||
				binding.workerId !== message.workerId ||
				(workId !== undefined && binding.workId !== workId)
			)
				throw new CoordinationError(409, "新 Session 的投递关联不一致");
			sessionId = binding.sessionId;
			workId ??= binding.workId;
		}
		if (message.replyTo) {
			const original = await this.store.readWorkerMessage(message.replyTo);
			if (!original) return { workerId: message.workerId, workId, status: "pending", reason: "reply_to 不存在" };
			if (original.workerId !== message.sourceWorkerId)
				throw new CoordinationError(409, "reply_to 不属于发送方 Worker");
			if (original.sourceWorkerId !== message.workerId)
				throw new CoordinationError(409, "reply_to 的目标 Worker 不匹配");
			const originalDelivery = await this.store.readWorkerDelivery(
				original.deliveryId ?? `${original.messageId}:delivery`,
			);
			const originalTargetSession = originalDelivery?.sessionId ?? original.targetSessionId;
			if (originalTargetSession && message.sourceSessionId !== originalTargetSession)
				throw new CoordinationError(409, "reply_to 不属于来源 Session");
			if (workId && original.workId && workId !== original.workId)
				throw new CoordinationError(409, "reply_to 与 workId 不匹配");
			workId ??= original.workId;
			sessionId ??= original.sourceSessionId;
			if (
				message.targetSessionId &&
				original.sourceSessionId &&
				message.targetSessionId !== original.sourceSessionId
			)
				throw new CoordinationError(409, "reply_to 与 targetSessionId 不匹配");
		}
		const workItem = workId ? await this.store.readWorkItem(workId) : undefined;
		if (workItem?.status === "stopped")
			return { workerId: message.workerId, workId, status: "pending", reason: "工作项已停止，不自动恢复" };
		if (workId && !workItem) {
			if (message.kind !== "request" || sessionId || message.replyTo)
				throw new CoordinationError(404, "工作项不存在");
			return { workerId: message.workerId, workId, status: "pending", reason: "需要创建工作项与工作 Session" };
		}
		if (message.newSession && !sessionId)
			return { workerId: message.workerId, workId, status: "pending", reason: "需要创建新的工作 Session" };
		if (sessionId) {
			const assignment = await this.store.findAssignmentBySession(sessionId);
			if (!assignment)
				return {
					workerId: message.workerId,
					...(workId ? { workId } : {}),
					sessionId,
					status: "pending",
					reason: "目标 Session 尚未关联",
				};
			if (assignment.workerId !== message.workerId)
				throw new CoordinationError(409, "targetSession 不属于目标 Worker");
			if (workId && assignment.workId !== workId) throw new CoordinationError(409, "targetSession 不属于 workId");
			const assignedWork = workItem ?? (await this.store.readWorkItem(assignment.workId));
			if (!assignedWork) throw new CoordinationError(404, "Session 关联的工作项不存在");
			if (assignedWork.status === "stopped")
				return {
					workerId: message.workerId,
					workId: assignment.workId,
					sessionId: assignment.sessionId,
					assignmentId: assignment.assignmentId,
					status: "pending",
					reason: "工作项已停止，不自动恢复",
				};
			if (assignment.status === "stopped" || assignment.stopRequested)
				return {
					workerId: message.workerId,
					workId: assignment.workId,
					sessionId: assignment.sessionId,
					assignmentId: assignment.assignmentId,
					status: "pending",
					reason: "目标 Session 已停止，不自动恢复",
				};
			return {
				workerId: message.workerId,
				workId: workId ?? assignment.workId,
				assignmentId: assignment.assignmentId,
				sessionId: assignment.sessionId,
				status: "resolved",
			};
		}
		if (workId) {
			const assignments = (await this.store.findAssignmentByWork(workId)).filter(
				(assignment) => assignment.workerId === message.workerId,
			);
			if (assignments.length === 1) {
				const assignment = assignments[0];
				if (assignment.status === "stopped" || assignment.stopRequested)
					return {
						workerId: message.workerId,
						workId,
						assignmentId: assignment.assignmentId,
						sessionId: assignment.sessionId,
						status: "pending",
						reason: "目标 Session 已停止，不自动恢复",
					};
				return {
					workerId: message.workerId,
					workId,
					assignmentId: assignment.assignmentId,
					sessionId: assignment.sessionId,
					status: "resolved",
				};
			}
			return {
				workerId: message.workerId,
				workId,
				status: "pending",
				reason: assignments.length ? "工作项存在多个目标 Session" : "工作项尚未关联目标 Session",
			};
		}
		return {
			workerId: message.workerId,
			status: "pending",
			reason: message.newSession ? "需要创建新的工作 Session" : "缺少目标 Session 或 workId",
		};
	}

	private async persistResolution(delivery: WorkerDelivery, resolution: WorkerResolution): Promise<WorkerDelivery> {
		const update: Partial<Pick<WorkerDelivery, "assignmentId" | "sessionId" | "status" | "error" | "updatedAt">> = {
			updatedAt: Date.now(),
			...(resolution.assignmentId ? { assignmentId: resolution.assignmentId } : {}),
			...(resolution.sessionId ? { sessionId: resolution.sessionId } : {}),
			status: resolution.status === "resolved" ? "resolved" : "pending",
			...(resolution.reason ? { error: resolution.reason } : { error: undefined }),
		};
		return this.store.updateWorkerDelivery(delivery.deliveryId, update);
	}

	async enqueueMessage(input: WorkerMessageCreate): Promise<WorkerEnqueueResult> {
		coordinationObject(input);
		if ("sequence" in input || "status" in input || "createdAt" in input)
			throw new CoordinationError(400, "消息序号、状态和创建时间由协调服务生成");
		const workerId = requiredCoordinationText(input.workerId, "目标 workerId");
		const sourceWorkerId = requiredCoordinationText(input.sourceWorkerId, "sourceWorkerId");
		requiredCoordinationText(input.content, "消息 content", 16000);
		const content = input.content;
		const kind = coordinationChoice(
			input.kind ?? "request",
			["request", "question", "reply", "progress", "result"] as const,
			"kind",
		);
		const sourceSessionId = optionalCoordinationText(input.sourceSessionId, "sourceSessionId");
		const sourceTurnId = optionalCoordinationText(input.sourceTurnId, "sourceTurnId");
		const workId = optionalCoordinationText(input.workId, "workId");
		const targetSessionId = optionalCoordinationText(input.targetSessionId, "targetSessionId");
		const replyTo = optionalCoordinationText(input.replyTo, "replyTo");
		const workspacePath = optionalCoordinationText(input.workspacePath, "workspacePath", 4096);
		const model = coordinationModel(input.model);
		const productBinding = coordinationProductBinding(input.productBinding);
		const title = optionalCoordinationText(input.title, "title", 100);
		const mode =
			input.mode === undefined ? undefined : coordinationChoice(input.mode, ["faux", "real"] as const, "mode");
		if (input.newSession !== undefined && typeof input.newSession !== "boolean")
			throw new CoordinationError(400, "newSession 需要布尔值");
		const target = await this.store.readWorker(workerId);
		if (!target) throw new CoordinationError(404, "目标 Worker 不存在");
		if (!(await this.store.readWorker(sourceWorkerId))) throw new CoordinationError(404, "来源 Worker 不存在");
		if (kind !== "request" && input.newSession)
			throw new CoordinationError(400, "只有 request 消息可以要求 newSession");
		if (input.newSession && (input.targetSessionId || input.replyTo))
			throw new CoordinationError(400, "newSession 不能与 targetSessionId 或 replyTo 同时使用");
		if (kind !== "request" && !input.targetSessionId && !input.replyTo && !input.workId)
			throw new CoordinationError(400, "该消息类型需要关联已有请求或会话");
		const messageId = optionalCoordinationText(input.messageId, "messageId") ?? randomUUID();
		const deliveryId = optionalCoordinationText(input.deliveryId, "deliveryId", 512) ?? `${messageId}:delivery`;
		const existingDelivery = await this.store.readWorkerDelivery(deliveryId);
		if (existingDelivery && (existingDelivery.messageId !== messageId || existingDelivery.workerId !== workerId))
			throw new CoordinationError(409, "deliveryId 已用于不同消息或 Worker");
		const request: WorkerMessageCreate = {
			messageId,
			workerId,
			sourceWorkerId,
			sourceSessionId,
			sourceTurnId,
			workId,
			targetSessionId,
			replyTo,
			kind,
			content,
			newSession: input.newSession,
			workspacePath,
			model,
			productBinding,
			title,
			mode,
			deliveryId,
		};
		const existingMessage = await this.store.readWorkerMessage(messageId);
		if (existingMessage) {
			if (!isDeepStrictEqual(workerMessageRequest(existingMessage), workerMessageRequest(request)))
				throw new CoordinationError(409, "messageId 已用于不同消息参数");
			if (existingDelivery) return { message: existingMessage, delivery: existingDelivery };
		}
		const sequence = existingMessage?.sequence ?? (await this.store.nextWorkerSequence(workerId));
		if (!Number.isSafeInteger(sequence) || sequence < 1) throw new CoordinationError(503, "Worker 消息序号无效");
		const message: WorkerMessage = {
			messageId,
			workerId,
			sourceWorkerId,
			...(sourceSessionId === undefined ? {} : { sourceSessionId }),
			...(sourceTurnId === undefined ? {} : { sourceTurnId }),
			...(workId === undefined ? {} : { workId }),
			...(targetSessionId === undefined ? {} : { targetSessionId }),
			...(replyTo === undefined ? {} : { replyTo }),
			kind,
			content,
			sequence,
			status: "queued",
			createdAt: existingMessage?.createdAt ?? Date.now(),
			...(input.newSession === undefined ? {} : { newSession: input.newSession }),
			...(workspacePath === undefined ? {} : { workspacePath }),
			...(model === undefined ? {} : { model }),
			...(productBinding === undefined ? {} : { productBinding }),
			...(title === undefined ? {} : { title }),
			...(mode === undefined ? {} : { mode }),
			deliveryId,
		};
		const resolution = await this.resolveFact(message);
		const savedMessage = existingMessage ?? (await this.store.createWorkerMessage(message));
		if (existingDelivery) return { message: savedMessage, delivery: existingDelivery };
		const now = Date.now();
		const delivery: WorkerDelivery = {
			deliveryId,
			messageId: savedMessage.messageId,
			workerId,
			...(resolution.assignmentId ? { assignmentId: resolution.assignmentId } : {}),
			...(resolution.sessionId ? { sessionId: resolution.sessionId } : {}),
			status: resolution.status === "resolved" ? "resolved" : "pending",
			...(resolution.reason ? { error: resolution.reason } : {}),
			createdAt: now,
			updatedAt: now,
		};
		const savedDelivery = await this.store.createWorkerDelivery(delivery);
		return { message: savedMessage, delivery: savedDelivery };
	}

	/** Resolve a persisted delivery using only message and assignment facts. */
	async resolveDelivery(deliveryOrId: WorkerDelivery | string): Promise<WorkerDelivery> {
		const delivery = await this.store.readWorkerDelivery(
			typeof deliveryOrId === "string" ? deliveryOrId : deliveryOrId.deliveryId,
		);
		if (!delivery) throw new CoordinationError(404, "Worker 投递不存在");
		if (delivery.status !== "pending" && delivery.status !== "resolved") return delivery;
		const message = await this.store.readWorkerMessage(delivery.messageId);
		if (!message) {
			return this.store.updateWorkerDelivery(delivery.deliveryId, {
				status: "failed",
				error: "消息事实不存在",
				updatedAt: Date.now(),
			});
		}
		const resolution = await this.resolveFact(message, delivery);
		return this.persistResolution(delivery, resolution);
	}

	async resolveMessage(messageOrId: WorkerMessage | string, deliveryId?: string): Promise<WorkerDelivery> {
		if (deliveryId) return this.resolveDelivery(deliveryId);
		const message = typeof messageOrId === "string" ? await this.store.readWorkerMessage(messageOrId) : messageOrId;
		if (!message) throw new CoordinationError(404, "Worker 消息不存在");
		return this.resolveDelivery(message.deliveryId ?? `${message.messageId}:delivery`);
	}

	/** Mark a resolved delivery as dispatched; unresolved facts remain pending. */
	async dispatchDelivery(deliveryOrId: WorkerDelivery | string): Promise<WorkerDelivery> {
		const resolved = await this.resolveDelivery(deliveryOrId);
		if (!resolved.sessionId || !resolved.assignmentId || resolved.status !== "resolved") return resolved;
		return this.store.updateWorkerDelivery(resolved.deliveryId, {
			status: "dispatched",
			error: undefined,
			updatedAt: Date.now(),
		});
	}

	async dispatchMessage(messageOrId: WorkerMessage | string, deliveryId?: string): Promise<WorkerDelivery> {
		if (deliveryId) return this.dispatchDelivery(deliveryId);
		const message = typeof messageOrId === "string" ? await this.store.readWorkerMessage(messageOrId) : messageOrId;
		if (!message) throw new CoordinationError(404, "Worker 消息不存在");
		return this.dispatchDelivery(message.deliveryId ?? `${message.messageId}:delivery`);
	}

	/** Short aliases for hosts that treat resolution and dispatch as operations. */
	resolve(deliveryOrId: WorkerDelivery | string) {
		return this.resolveDelivery(deliveryOrId);
	}

	dispatch(deliveryOrId: WorkerDelivery | string) {
		return this.dispatchDelivery(deliveryOrId);
	}
}
