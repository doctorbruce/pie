import { createHash, randomUUID } from "node:crypto";
import {
	CoordinationError,
	WorkerCoordinationService,
	type WorkerCoordinationStore,
	type WorkerDelivery,
	type WorkerEnqueueResult,
	type WorkerMessage,
	type WorkerMessageCreate,
	type WorkerProductBinding,
	type WorkItemCreate,
} from "./coordination.ts";
import type { HostRuntimeDefinition, Turn, TurnReceipt } from "./protocol.ts";
import { type CreateSessionInput, RuntimeError, type TurnInput } from "./runtime.ts";

/** Only the existing Session/Turn boundary is needed; no Agent or Local dependency. */
export interface WorkerSchedulerRuntime {
	createSession(input: CreateSessionInput): Promise<{ id: string }>;
	submitTurn(sessionId: string, input: TurnInput): Promise<TurnReceipt>;
	waitForTurn(
		sessionId: string,
		options?: {
			onWait?(turn: Turn | undefined): void;
			onSettled?(turn: Turn | undefined): void;
		},
	): Promise<{ turn?: Turn }>;
}

function sessionCreationKey(message: WorkerMessage) {
	const identity = message.newSession ? message.messageId : message.workId;
	return `worker-session:${createHash("sha256")
		.update(JSON.stringify([message.workerId, message.newSession ? "message" : "work", identity]))
		.digest("hex")}`;
}

function productSessionId(binding: WorkerProductBinding | undefined) {
	if (typeof binding === "string") return binding;
	return typeof binding?.astronSessionId === "string" ? binding.astronSessionId : undefined;
}

/**
 * Inbox persistence and deterministic association precede execution. The route
 * queue only owns short association operations; execution is serial per Session.
 * Restart recovery is deliberately explicit: accepted/dispatched deliveries are
 * never submitted again merely because a host repeats an enqueue request.
 */
export class WorkerScheduler {
	private readonly runtime: WorkerSchedulerRuntime;
	private readonly store: WorkerCoordinationStore;
	private readonly coordination: WorkerCoordinationService;
	private inbox = Promise.resolve();
	private routes = Promise.resolve();
	private readonly sessions = new Map<string, Promise<void>>();
	private readonly pending = new Map<string, Promise<WorkerDelivery>>();
	private readonly latestSequence = new Map<string, number>();
	private readonly cancelledThrough = new Map<string, number>();
	private configuredWorkerIds: Set<string> | undefined;
	private stopping = false;

	constructor(options: { runtime: WorkerSchedulerRuntime; store: WorkerCoordinationStore }) {
		this.runtime = options.runtime;
		this.store = options.store;
		this.coordination = new WorkerCoordinationService(options.store);
	}

	async syncHostRuntimes(definitions: readonly HostRuntimeDefinition[]) {
		for (const definition of definitions) {
			const current = await this.coordination.readWorker(definition.assistantId);
			await this.coordination.registerWorker({
				...current,
				assistantId: definition.assistantId,
				workerId: definition.assistantId,
				assistantRevision: definition.assistantRevision,
				status: current?.status ?? "active",
			});
		}
		this.configuredWorkerIds = new Set(definitions.map((definition) => definition.assistantId));
		return this.listWorkers();
	}

	listWorkers() {
		return this.coordination.listWorkers();
	}

	createWorkItem(input: WorkItemCreate) {
		return this.coordination.createWorkItem(input);
	}

	async getWorkerMessage(messageId: string) {
		const message = await this.coordination.readWorkerMessage(messageId);
		if (!message) throw new CoordinationError(404, "Worker 消息不存在");
		return message;
	}

	async getWorkerDelivery(deliveryId: string) {
		const delivery = await this.coordination.readWorkerDelivery(deliveryId);
		if (!delivery) throw new CoordinationError(404, "Worker 投递不存在");
		return delivery;
	}

	enqueueWorkerMessage(input: WorkerMessageCreate): Promise<WorkerEnqueueResult> {
		const received = this.inbox.then(() => this.receive(input));
		this.inbox = received.then(
			() => {},
			() => {},
		);
		return received;
	}

	private async receive(input: WorkerMessageCreate): Promise<WorkerEnqueueResult> {
		if (this.stopping) throw new CoordinationError(503, "Worker 调度器正在关闭");
		if (!input || typeof input !== "object" || Array.isArray(input))
			throw new CoordinationError(400, "Worker 收件需要对象");
		if (input.messageId !== undefined && typeof input.messageId !== "string")
			throw new CoordinationError(400, "messageId 需要字符串");
		const messageId = input.messageId === undefined ? randomUUID() : input.messageId.trim();
		const newWork =
			(input.kind ?? "request") === "request" && !input.workId && !input.targetSessionId && !input.replyTo;
		const received = await this.coordination.enqueueMessage({
			...input,
			messageId,
			...(newWork ? { workId: `work:${createHash("sha256").update(messageId).digest("hex")}` } : {}),
		});
		this.latestSequence.set(
			received.message.workerId,
			Math.max(this.latestSequence.get(received.message.workerId) ?? 0, received.message.sequence),
		);
		if (
			!this.pending.has(received.delivery.deliveryId) &&
			(received.delivery.status === "pending" || received.delivery.status === "resolved")
		)
			this.schedule(received);
		return received;
	}

	async waitWorkerDelivery(deliveryId: string): Promise<WorkerDelivery> {
		const pending = this.pending.get(deliveryId);
		if (pending) return pending;
		const delivery = await this.coordination.readWorkerDelivery(deliveryId);
		if (!delivery) throw new CoordinationError(404, "Worker 投递不存在");
		return delivery;
	}

	stop() {
		this.stopping = true;
	}

	async drain() {
		await this.inbox;
		await Promise.allSettled([...this.pending.values()]);
	}

	private schedule(received: WorkerEnqueueResult) {
		const routed = this.routes.then(async () => {
			if (this.stopping) return { delivery: received.delivery };
			const delivery = await this.associate(received);
			return {
				delivery,
				...(delivery.status === "resolved" && delivery.sessionId
					? { run: this.queueSession(received.message, delivery) }
					: {}),
			};
		});
		this.routes = routed.then(
			() => {},
			() => {},
		);
		const completion = routed
			.then((result) => result.run ?? result.delivery)
			.catch((error: unknown) => this.failDelivery(received.delivery, error));
		this.pending.set(received.delivery.deliveryId, completion);
		void completion.then(
			() => this.pending.delete(received.delivery.deliveryId),
			() => this.pending.delete(received.delivery.deliveryId),
		);
	}

	private async associate(received: WorkerEnqueueResult): Promise<WorkerDelivery> {
		const { message } = received;
		const current = await this.store.readWorkerDelivery(received.delivery.deliveryId);
		if (!current) throw new CoordinationError(404, "Worker 投递不存在");
		if (current.status !== "pending" && current.status !== "resolved") return current;
		const worker = await this.coordination.readWorker(message.workerId);
		if (!worker) throw new CoordinationError(404, "目标 Worker 不存在");
		if (this.configuredWorkerIds && !this.configuredWorkerIds.has(worker.workerId))
			throw new CoordinationError(409, "目标 Worker 的助手配置已移除");
		if (worker.status === "stopped") throw new CoordinationError(409, "目标 Worker 已停止");
		if (worker.status === "paused") return current;
		if (current.sessionId && current.assignmentId) return current;
		if (message.targetSessionId || message.replyTo) return this.coordination.resolveDelivery(current);
		if (message.kind !== "request" || !message.workId) return current;
		const assignments = (await this.coordination.findAssignmentByWork(message.workId)).filter(
			(assignment) => assignment.workerId === message.workerId,
		);
		if (!message.newSession && assignments.length) return this.coordination.resolveDelivery(current);
		const work = await this.coordination.readWorkItem(message.workId);
		if (work?.status === "stopped") throw new CoordinationError(409, "目标工作项已停止");
		if (!work)
			await this.coordination.createWorkItem({
				workId: message.workId,
				title: message.title ?? message.content.slice(0, 100),
				sourceWorkerId: message.sourceWorkerId,
				sourceSessionId: message.sourceSessionId,
			});
		const creationKey = sessionCreationKey(message);
		const workspacePath = message.workspacePath ?? worker.defaultWorkspacePath;
		const model = message.model ?? worker.defaultModel;
		const productBinding = message.productBinding ?? worker.productBinding;
		const created = await this.runtime.createSession({
			creationKey,
			assistantId: worker.assistantId,
			astronSessionId: productSessionId(productBinding),
			title: message.title ?? work?.title.slice(0, 100) ?? message.content.slice(0, 100),
			workspacePath,
			model,
			mode: message.mode,
		});
		const assignment = await this.coordination.createAssignment({
			assignmentId: `${creationKey}:assignment`,
			creationKey,
			workId: message.workId,
			workerId: message.workerId,
			sessionId: created.id,
			workspacePath,
			model,
			productBinding,
		});
		return this.store.updateWorkerDelivery(current.deliveryId, {
			assignmentId: assignment.assignmentId,
			sessionId: assignment.sessionId,
			status: "resolved",
			error: undefined,
			updatedAt: Date.now(),
		});
	}

	private queueSession(message: WorkerMessage, delivery: WorkerDelivery): Promise<WorkerDelivery> {
		const sessionId = delivery.sessionId!;
		const previous = this.sessions.get(sessionId) ?? Promise.resolve();
		const run = previous.then(() => this.execute(message, delivery));
		const tail = run.then(
			() => {},
			() => {},
		);
		this.sessions.set(sessionId, tail);
		void tail.then(() => {
			if (this.sessions.get(sessionId) === tail) this.sessions.delete(sessionId);
		});
		return run;
	}

	private async execute(message: WorkerMessage, delivery: WorkerDelivery): Promise<WorkerDelivery> {
		const sessionId = delivery.sessionId!;
		const admitted = await this.admit(message, delivery);
		if ("delivery" in admitted) return admitted.delivery;
		const settled = this.runtime.waitForTurn(sessionId, {
			onWait: (turn) => {
				if (turn?.id !== admitted.receipt.turnId)
					throw new CoordinationError(409, "受理的 Turn 已被替换，投递需要对账");
			},
			onSettled: (turn) => {
				if (turn?.id === admitted.receipt.turnId) this.recordSettlement(sessionId, message, turn);
			},
		});
		// Acceptance persistence may fail while Runtime is still settling this Turn.
		void settled.catch(() => {});
		const accepted = await this.store.updateWorkerDelivery(delivery.deliveryId, {
			status: "accepted",
			acceptedTurnId: admitted.receipt.turnId,
			updatedAt: Date.now(),
		});
		await settled;
		return this.store.updateWorkerDelivery(accepted.deliveryId, {
			status: "consumed",
			consumedAt: Date.now(),
			updatedAt: Date.now(),
		});
	}

	private recordSettlement(sessionId: string, message: WorkerMessage, turn: Turn | undefined) {
		if (turn?.status === "cancelled" || turn?.status === "failed" || turn?.status === "interrupted")
			this.cancelledThrough.set(sessionId, this.latestSequence.get(message.workerId) ?? message.sequence);
	}

	private async admit(
		message: WorkerMessage,
		delivery: WorkerDelivery,
	): Promise<{ receipt: TurnReceipt } | { delivery: WorkerDelivery }> {
		const sessionId = delivery.sessionId!;
		let rejectedWhileBusy = false;
		while (!this.stopping) {
			let waitingTurnId: string | undefined;
			await this.runtime.waitForTurn(sessionId, {
				onWait: (turn) => {
					if (turn?.status === "running") waitingTurnId = turn.id;
				},
				onSettled: (turn) => {
					if (rejectedWhileBusy || (waitingTurnId !== undefined && turn?.id === waitingTurnId))
						this.recordSettlement(sessionId, message, turn);
				},
			});
			if (this.stopping) break;
			if (message.sequence <= (this.cancelledThrough.get(sessionId) ?? 0))
				return {
					delivery: await this.failDelivery(delivery, new Error("前一 Turn 已取消，排队消息未自动重启执行")),
				};
			const worker = await this.coordination.readWorker(message.workerId);
			const assignment = await this.coordination.findAssignmentBySession(sessionId);
			if (worker?.status === "paused") break;
			if (
				!worker ||
				(this.configuredWorkerIds && !this.configuredWorkerIds.has(message.workerId)) ||
				worker.status === "stopped" ||
				!assignment ||
				assignment.stopRequested ||
				assignment.status === "stopped"
			)
				return { delivery: await this.failDelivery(delivery, new Error("目标 Worker 或 Session 已停止")) };
			const work = await this.coordination.readWorkItem(assignment.workId);
			if (work?.status === "stopped")
				return { delivery: await this.failDelivery(delivery, new Error("目标工作项已停止")) };
			await this.store.updateWorkerDelivery(delivery.deliveryId, { status: "dispatched", updatedAt: Date.now() });
			if (this.stopping) {
				await this.store.updateWorkerDelivery(delivery.deliveryId, { status: "resolved", updatedAt: Date.now() });
				break;
			}
			try {
				return {
					receipt: await this.runtime.submitTurn(sessionId, {
						text: message.content,
						requestId: message.messageId,
						model: assignment.model,
					}),
				};
			} catch (error) {
				if (
					!(error instanceof RuntimeError) ||
					error.status !== 409 ||
					(error.reason !== "turn_running" &&
						error.reason !== "cancellation_requested" &&
						error.reason !== "cancellation_in_progress")
				)
					throw error;
				// These gates reject before admission; only this known result is safe to retry.
				await this.store.updateWorkerDelivery(delivery.deliveryId, {
					status: "resolved",
					error: undefined,
					updatedAt: Date.now(),
				});
				rejectedWhileBusy = true;
			}
		}
		return { delivery: await this.getWorkerDelivery(delivery.deliveryId) };
	}

	private async failDelivery(delivery: WorkerDelivery, error: unknown): Promise<WorkerDelivery> {
		const current = await this.store.readWorkerDelivery(delivery.deliveryId);
		if (!current) throw error;
		return this.store.updateWorkerDelivery(delivery.deliveryId, {
			// Once Runtime may have accepted it, preserve that uncertainty for reconciliation.
			status: current.status === "accepted" || current.status === "dispatched" ? current.status : "failed",
			error: error instanceof Error ? error.message : String(error),
			updatedAt: Date.now(),
		});
	}
}
