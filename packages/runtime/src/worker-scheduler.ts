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
import type { RuntimeStore } from "./runtime-store.ts";
import type {
	WorkerCallContext,
	WorkerCommunication,
	WorkerCommunicationStore,
	WorkerSendInput,
	WorkerWaitOptions,
	WorkerWaitResult,
} from "./worker-communication.ts";

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
export class WorkerScheduler implements WorkerCommunication {
	private readonly runtime: WorkerSchedulerRuntime;
	private readonly store: WorkerCoordinationStore &
		Partial<WorkerCommunicationStore & Pick<RuntimeStore, "readSession">>;
	private readonly coordination: WorkerCoordinationService;
	private inbox = Promise.resolve();
	private routes = Promise.resolve();
	private readonly sessions = new Map<string, Promise<void>>();
	private readonly pending = new Map<string, Promise<WorkerDelivery>>();
	private readonly latestSequence = new Map<string, number>();
	private readonly cancelledThrough = new Map<string, number>();
	private readonly recordedSettlements = new Map<string, string>();
	private readonly settlementWrites = new Map<string, Promise<void>>();
	private readonly waitChanges = new Map<string, Set<() => void>>();
	private hostWorkerIds = new Set<string>();
	private localWorkerIds = new Set<string>();
	private configuredWorkerIds: Set<string> | undefined;
	private stopping = false;

	constructor(options: {
		runtime: WorkerSchedulerRuntime;
		store: WorkerCoordinationStore & Partial<WorkerCommunicationStore & Pick<RuntimeStore, "readSession">>;
	}) {
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
		this.hostWorkerIds = new Set(definitions.map((definition) => definition.assistantId));
		this.refreshConfiguredWorkerIds();
		return this.listWorkers();
	}

	async syncAssistant(input: { id: string; updatedAt: number }) {
		if (this.stopping) throw new CoordinationError(503, "Worker 调度器正在关闭");
		if (this.hostWorkerIds.has(input.id)) {
			const existing = await this.coordination.readWorker(input.id);
			this.localWorkerIds.add(input.id);
			this.refreshConfiguredWorkerIds();
			return existing;
		}
		const current = await this.coordination.readWorker(input.id);
		const worker = await this.coordination.registerWorker({
			...current,
			assistantId: input.id,
			workerId: input.id,
			assistantRevision: input.updatedAt,
			status: current?.status ?? "active",
		});
		this.localWorkerIds.add(input.id);
		this.refreshConfiguredWorkerIds();
		return worker;
	}

	async deleteAssistant(input: string) {
		if (!this.hostWorkerIds.has(input)) await this.coordination.deleteWorker(input);
		this.localWorkerIds.delete(input);
		this.refreshConfiguredWorkerIds();
	}

	listWorkers() {
		return this.coordination.listWorkers();
	}

	createWorkItem(input: WorkItemCreate) {
		return this.coordination.createWorkItem(input);
	}

	/** An empty host-created Worker Session is usable only after its durable association exists. */
	async createWorkerSession(input: CreateSessionInput): Promise<{ id: string }> {
		if (this.stopping) throw new CoordinationError(503, "Worker 调度器正在关闭");
		if (!input.workerId || input.workerId !== input.assistantId)
			throw new CoordinationError(400, "Worker Session 需要匹配的 workerId 和 assistantId");
		const created = await this.runtime.createSession(input);
		const identity = createHash("sha256")
			.update(JSON.stringify([input.workerId, created.id]))
			.digest("hex");
		const workId = `worker-work:${identity}`;
		await this.coordination.createWorkItem({
			workId,
			title: input.title?.trim() ?? "新会话",
			sourceWorkerId: input.workerId,
			sourceSessionId: created.id,
		});
		await this.coordination.createAssignment({
			assignmentId: `worker-assignment:${identity}`,
			creationKey: input.creationKey,
			workId,
			workerId: input.workerId,
			sessionId: created.id,
			workspacePath: input.workspacePath?.trim(),
			model: input.model,
			productBinding: { assistantId: input.assistantId, astronSessionId: input.astronSessionId ?? created.id },
		});
		return created;
	}

	private async sessionAssignment(workerId: string, sessionId: string) {
		const existing = await this.store.findAssignmentBySession(sessionId);
		if (existing) {
			if (existing.workerId !== workerId) throw new CoordinationError(403, "Session 不属于指定助手");
			return existing;
		}
		if (!this.store.readSession) throw new CoordinationError(405, "当前协调存储不支持会话懒关联");
		const session = await this.store.readSession(sessionId);
		if (
			!session ||
			session.kind !== "root" ||
			session.assistantId !== workerId ||
			(session.workerId !== undefined && session.workerId !== workerId)
		)
			throw new CoordinationError(403, "Session 不属于指定助手");
		const identity = createHash("sha256")
			.update(JSON.stringify([workerId, sessionId]))
			.digest("hex");
		const workId = `worker-work:${identity}`;
		if (!(await this.coordination.readWorkItem(workId)))
			await this.coordination.createWorkItem({
				workId,
				title: session.title,
				sourceWorkerId: workerId,
				sourceSessionId: sessionId,
			});
		return this.coordination.createAssignment(
			{
				assignmentId: `worker-assignment:${identity}`,
				workId,
				workerId,
				sessionId,
				workspacePath: session.workspacePath,
				productBinding: { assistantId: workerId, astronSessionId: session.astronSessionId ?? sessionId },
			},
			{ requireSession: true },
		);
	}

	async send(context: WorkerCallContext, input: WorkerSendInput, signal?: AbortSignal): Promise<WorkerEnqueueResult> {
		signal?.throwIfAborted();
		const assignment = await this.sessionAssignment(context.workerId, context.sessionId);
		if (await this.store.isWorkerTurnCancelled?.(context.sessionId, context.turnId))
			throw new CoordinationError(409, "来源 Turn 已取消");
		if (!input || typeof input !== "object" || typeof input.to !== "string")
			throw new CoordinationError(400, "消息需要目标助手");
		let workId = assignment.workId;
		if (input.reply_to) {
			const original = await this.getWorkerMessage(input.reply_to);
			const delivery = await this.getWorkerDelivery(original.deliveryId ?? `${original.messageId}:delivery`);
			if (
				original.workerId !== context.workerId ||
				original.sourceWorkerId !== input.to ||
				delivery.sessionId !== context.sessionId ||
				(input.session_id !== undefined && input.session_id !== original.sourceSessionId)
			)
				throw new CoordinationError(403, "reply_to 不属于当前 Session 的合法往返");
			workId = original.workId ?? assignment.workId;
		} else if (!context.targets.some((target) => target.assistantId === input.to)) {
			throw new CoordinationError(403, "目标助手未获准通信");
		} else if (input.session_id !== undefined) {
			const targetAssignment = await this.sessionAssignment(input.to, input.session_id);
			workId = targetAssignment.workId;
		}
		const messageId = `worker-message:${createHash("sha256")
			.update(JSON.stringify([context.sessionId, context.turnId, context.toolCallId]))
			.digest("hex")}`;
		if (await this.store.isWorkerMessageCancelled?.(messageId))
			throw new CoordinationError(409, "Worker 请求已取消，不能再次发送");
		signal?.throwIfAborted();
		const sent = this.inbox.then(async () => {
			const existing = await this.store.readWorkerMessage(messageId);
			if (!existing && this.configuredWorkerIds && !this.configuredWorkerIds.has(context.workerId))
				throw new CoordinationError(409, "来源 Worker 的助手配置已移除");
			signal?.throwIfAborted();
			return this.receive({
				messageId,
				workerId: input.to,
				sourceWorkerId: context.workerId,
				sourceSessionId: context.sessionId,
				sourceTurnId: context.turnId,
				workId,
				content: input.content,
				kind: input.kind,
				targetSessionId: input.session_id,
				replyTo: input.reply_to,
				newSession: input.new_session,
				mode: context.mode,
			});
		});
		this.inbox = sent.then(
			() => {},
			() => {},
		);
		return sent;
	}

	async wait(
		context: WorkerCallContext,
		messageId: string,
		signal?: AbortSignal,
		options?: WorkerWaitOptions,
	): Promise<WorkerWaitResult> {
		signal?.throwIfAborted();
		if (!this.store.registerWorkerWait) throw new CoordinationError(405, "当前存储不支持 Worker 等待");
		const waitId = `worker-wait:${createHash("sha256")
			.update(JSON.stringify([context.sessionId, context.turnId, context.toolCallId]))
			.digest("hex")}`;
		if ((options?.mode ?? "async") === "async")
			return this.store.registerWorkerWait(context, messageId, waitId, options);
		if (options?.mode !== "sync") throw new CoordinationError(400, "Worker 等待模式无效");
		if (!this.store.finishWorkerWait || !this.store.isWorkerDeliveryClaimed)
			throw new CoordinationError(405, "当前存储不支持同步 Worker 等待");
		const timeoutMs = options.timeoutMs;
		if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000))
			throw new CoordinationError(400, "同步等待超时需要有效的正整数毫秒数");
		const intervalMs = 30_000;
		const startedAt = Date.now();
		const deadline = timeoutMs === undefined ? undefined : startedAt + timeoutMs;
		let changed = 0;
		let resume: (() => void) | undefined;
		const wake = () => {
			changed++;
			resume?.();
		};
		const changes = this.waitChanges.get(context.sessionId) ?? new Set<() => void>();
		changes.add(wake);
		this.waitChanges.set(context.sessionId, changes);
		const timer = setTimeout(wake, Math.min(timeoutMs ?? intervalMs, intervalMs));
		signal?.addEventListener("abort", wake, { once: true });
		let registered = false;
		try {
			while (!this.stopping) {
				signal?.throwIfAborted();
				const observed = changed;
				const result = await this.store.registerWorkerWait(context, messageId, waitId, options);
				registered = true;
				signal?.throwIfAborted();
				if (result.wait.status !== "waiting") return result;
				const original = await this.getWorkerMessage(messageId);
				const delivery = await this.getWorkerDelivery(original.deliveryId ?? `${messageId}:delivery`);
				if (delivery.status === "consumed" && delivery.error) {
					// This transaction decides between an available response and the observed execution failure.
					const latest = await this.store.registerWorkerWait(context, messageId, waitId, options);
					signal?.throwIfAborted();
					if (latest.wait.status !== "waiting") return latest;
					await this.store.finishWorkerWait(context, waitId, "cancelled");
					throw new CoordinationError(409, delivery.error);
				}
				if (deadline !== undefined && Date.now() >= deadline)
					return this.store.finishWorkerWait(context, waitId, "timed_out");
				const inputs = await this.inputs(context.sessionId);
				signal?.throwIfAborted();
				const reason = inputs.length ? "message" : Date.now() - startedAt >= intervalMs ? "interval" : undefined;
				if (reason) {
					// Prefer a response that arrived while reading the inbox over returning a pending wait.
					const latest = await this.store.registerWorkerWait(context, messageId, waitId, options);
					signal?.throwIfAborted();
					return latest.wait.status === "waiting" ? { ...latest, reason } : latest;
				}
				await new Promise<void>((resolve) => {
					resume = resolve;
					if (changed !== observed) resolve();
				});
			}
			throw new CoordinationError(503, "Worker 调度器正在关闭，同步等待未完成");
		} catch (error) {
			if (registered && signal?.aborted) await this.store.finishWorkerWait(context, waitId, "cancelled");
			throw error;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", wake);
			changes.delete(wake);
			if (!changes.size) this.waitChanges.delete(context.sessionId);
		}
	}

	async cancel(sessionId: string, turnId: string): Promise<void> {
		if (!this.store.cancelWorkerTurn) throw new CoordinationError(405, "当前存储不支持 Worker 取消");
		await this.store.cancelWorkerTurn(sessionId, turnId);
		this.notifyWaiters(sessionId);
	}

	async inputs(sessionId: string): Promise<WorkerEnqueueResult[]> {
		if (!this.store.listWorkerInputs) return [];
		const cutoff = await this.cancellationCutoff(sessionId);
		const inputs = await this.store.listWorkerInputs(sessionId);
		const assignment = await this.coordination.findAssignmentBySession(sessionId);
		const worker = assignment ? await this.coordination.readWorker(assignment.workerId) : undefined;
		if (worker?.status === "paused") return [];
		const work = assignment ? await this.coordination.readWorkItem(assignment.workId) : undefined;
		const stopped =
			!worker ||
			(this.configuredWorkerIds !== undefined && !this.configuredWorkerIds.has(worker.workerId)) ||
			worker.status === "stopped" ||
			!assignment ||
			assignment.stopRequested ||
			assignment.status === "stopped" ||
			work?.status === "stopped";
		const available: WorkerEnqueueResult[] = [];
		for (const input of inputs) {
			if (input.delivery.status !== "resolved") continue;
			if (await this.store.isWorkerDeliveryClaimed?.(input.delivery.deliveryId)) continue;
			if (stopped) {
				await this.failDelivery(input.delivery, new Error("目标 Worker、Session 或工作项已停止"));
				continue;
			}
			if (await this.replyCancelled(input.message)) {
				await this.failDelivery(input.delivery, new Error("原请求 Turn 已取消，回复不自动恢复执行"));
				continue;
			}
			if (input.message.sequence <= cutoff) {
				await this.failDelivery(input.delivery, new Error("前一 Turn 已取消，排队消息未自动重启执行"));
				continue;
			}
			available.push(input);
		}
		return available;
	}

	private async replyCancelled(message: WorkerMessage): Promise<boolean> {
		if (!message.replyTo) return false;
		if (this.store.isWorkerMessageCancelled) return this.store.isWorkerMessageCancelled(message.replyTo);
		if (!this.store.isWorkerTurnCancelled) return false;
		const original = await this.getWorkerMessage(message.replyTo);
		return Boolean(
			original.sourceSessionId &&
				original.sourceTurnId &&
				(await this.store.isWorkerTurnCancelled(original.sourceSessionId, original.sourceTurnId)),
		);
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
		for (const changes of this.waitChanges.values()) for (const wake of changes) wake();
	}

	private notifyWaiters(sessionId: string) {
		for (const wake of this.waitChanges.get(sessionId) ?? []) wake();
	}

	private refreshConfiguredWorkerIds() {
		this.configuredWorkerIds = new Set([...this.hostWorkerIds, ...this.localWorkerIds]);
	}

	async drain() {
		await this.inbox;
		await Promise.allSettled([...this.pending.values()]);
	}

	/** Report durable control failures even when their paused deliveries are no longer scheduled. */
	async reportFailedDeliveries(deliveries: readonly WorkerDelivery[]): Promise<void> {
		for (const delivery of deliveries) {
			if (delivery.status !== "failed") continue;
			const message = await this.getWorkerMessage(delivery.messageId);
			if (message.sourceSessionId) {
				const source = await this.store.readWorker(message.sourceWorkerId);
				const assignment = await this.store.findAssignmentBySession(message.sourceSessionId);
				if (
					!source ||
					source.status === "stopped" ||
					!assignment ||
					assignment.status === "stopped" ||
					assignment.stopRequested
				)
					continue;
			}
			await this.failDelivery(delivery, new Error(delivery.error ?? "Worker 投递已终止"));
		}
	}

	private schedule(received: WorkerEnqueueResult) {
		const routed = this.routes.then(async () => {
			if (this.stopping) return { delivery: received.delivery };
			const delivery = await this.associate(received);
			if (delivery.sessionId) this.notifyWaiters(delivery.sessionId);
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
			workerId: worker.workerId,
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
		let turnId: string;
		if ("delivery" in admitted) {
			if (admitted.delivery.status !== "consumed" || !admitted.delivery.acceptedTurnId) return admitted.delivery;
			turnId = admitted.delivery.acceptedTurnId;
		} else {
			turnId = admitted.receipt.turnId;
		}
		const identity = JSON.stringify([sessionId, turnId]);
		let executionError = this.recordedSettlements.get(identity);
		const settled = executionError
			? Promise.resolve()
			: this.runtime.waitForTurn(sessionId, {
					onWait: (turn) => {
						if (turn?.id !== turnId) throw new CoordinationError(409, "受理的 Turn 已被替换，投递需要对账");
						if (turn.status === "running") this.recordedSettlements.delete(identity);
					},
					onSettled: (turn) => {
						if (turn?.id !== turnId) return;
						this.recordSettlement(sessionId, message, turn);
						executionError = this.recordedSettlements.get(identity);
					},
				});
		// Acceptance persistence may fail while Runtime is still settling this Turn.
		void settled.catch(() => {});
		const current = await this.getWorkerDelivery(delivery.deliveryId);
		const accepted =
			current.status === "consumed"
				? current
				: await this.store.updateWorkerDelivery(delivery.deliveryId, {
						status: "accepted",
						acceptedTurnId: turnId,
						updatedAt: Date.now(),
					});
		await settled;
		await this.settlementWrites.get(sessionId);
		const consumed = await this.getWorkerDelivery(delivery.deliveryId);
		if (consumed.status === "consumed" && !executionError) return consumed;
		const completed = await this.store.updateWorkerDelivery(accepted.deliveryId, {
			status: "consumed",
			acceptedTurnId: turnId,
			error: executionError,
			consumedAt: consumed.consumedAt ?? Date.now(),
			updatedAt: Date.now(),
		});
		if (executionError && message.sourceSessionId) this.notifyWaiters(message.sourceSessionId);
		return completed;
	}

	private recordSettlement(sessionId: string, message: WorkerMessage, turn: Turn | undefined) {
		if (!turn || !["cancelled", "failed", "interrupted"].includes(turn.status)) return;
		const identity = JSON.stringify([sessionId, turn.id]);
		if (this.recordedSettlements.has(identity)) return;
		this.recordedSettlements.set(
			identity,
			`目标 Worker Turn ${turn.status}：${turn.error?.slice(0, 1000) ?? "执行未完成"}`,
		);
		const sequence = this.latestSequence.get(message.workerId) ?? message.sequence;
		this.cancelledThrough.set(sessionId, Math.max(this.cancelledThrough.get(sessionId) ?? 0, sequence));
		const previous = this.settlementWrites.get(sessionId) ?? Promise.resolve();
		const write = previous.then(async () => {
			if (this.store.recordWorkerTurnCutoff)
				this.cancelledThrough.set(
					sessionId,
					await this.store.recordWorkerTurnCutoff(sessionId, turn.id, message.workerId, sequence),
				);
		});
		this.settlementWrites.set(sessionId, write);
		void write.catch(() => {});
	}

	private async cancellationCutoff(sessionId: string): Promise<number> {
		await this.settlementWrites.get(sessionId);
		return Math.max(
			this.cancelledThrough.get(sessionId) ?? 0,
			(await this.store.readWorkerTurnCutoff?.(sessionId)) ?? 0,
		);
	}

	private async admit(
		message: WorkerMessage,
		delivery: WorkerDelivery,
	): Promise<{ receipt: TurnReceipt } | { delivery: WorkerDelivery }> {
		const sessionId = delivery.sessionId!;
		let rejectedWhileBusy = false;
		while (!this.stopping) {
			const current = await this.getWorkerDelivery(delivery.deliveryId);
			if (current.status !== "resolved") return { delivery: current };
			if (await this.store.isWorkerDeliveryClaimed?.(delivery.deliveryId)) return { delivery: current };
			let waitingTurnId: string | undefined;
			await this.runtime.waitForTurn(sessionId, {
				onWait: (turn) => {
					if (turn?.status === "running") {
						waitingTurnId = turn.id;
						this.recordedSettlements.delete(JSON.stringify([sessionId, turn.id]));
					}
				},
				onSettled: (turn) => {
					if (rejectedWhileBusy || (waitingTurnId !== undefined && turn?.id === waitingTurnId))
						this.recordSettlement(sessionId, message, turn);
				},
			});
			if (this.stopping) break;
			const afterWait = await this.getWorkerDelivery(delivery.deliveryId);
			if (afterWait.status !== "resolved") return { delivery: afterWait };
			if (await this.store.isWorkerDeliveryClaimed?.(delivery.deliveryId)) return { delivery: afterWait };
			if (await this.replyCancelled(message))
				return {
					delivery: await this.failDelivery(delivery, new Error("原请求 Turn 已取消，回复不自动恢复执行")),
				};
			if (message.sequence <= (await this.cancellationCutoff(sessionId)))
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
						workerDeliveryId: delivery.deliveryId,
						model: assignment.model,
					}),
				};
			} catch (error) {
				if (error instanceof CoordinationError && error.status === 409) {
					const rejected = await this.getWorkerDelivery(delivery.deliveryId);
					if (rejected.status === "consumed") return { delivery: rejected };
					let rejection = error;
					if (error.message === "目标 Worker 已暂停，暂不接纳输入") {
						const targetWorker = await this.coordination.readWorker(message.workerId);
						const targetAssignment = await this.coordination.findAssignmentBySession(sessionId);
						const targetWork = targetAssignment
							? await this.coordination.readWorkItem(targetAssignment.workId)
							: undefined;
						if (
							targetWorker &&
							targetWorker.status !== "stopped" &&
							(!this.configuredWorkerIds || this.configuredWorkerIds.has(message.workerId)) &&
							targetAssignment?.workerId === message.workerId &&
							targetAssignment.status !== "stopped" &&
							!targetAssignment.stopRequested &&
							targetWork &&
							targetWork.status !== "stopped" &&
							message.sequence > (await this.cancellationCutoff(sessionId)) &&
							!(await this.replyCancelled(message))
						) {
							await this.store.updateWorkerDelivery(delivery.deliveryId, {
								status: "resolved",
								error: undefined,
								updatedAt: Date.now(),
							});
							break;
						}
						rejection = new CoordinationError(409, "暂停后目标或请求已停止，消息未接纳");
					}
					const failed = await this.store.updateWorkerDelivery(delivery.deliveryId, {
						status: "failed",
						error: rejection.message,
						updatedAt: Date.now(),
					});
					return { delivery: await this.failDelivery(failed, rejection) };
				}
				if (
					!(error instanceof RuntimeError) ||
					error.status !== 409 ||
					(error.reason !== "turn_running" &&
						error.reason !== "session_compacting" &&
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
				if (error.reason !== "session_compacting") rejectedWhileBusy = true;
			}
		}
		return { delivery: await this.getWorkerDelivery(delivery.deliveryId) };
	}

	private async failDelivery(delivery: WorkerDelivery, error: unknown): Promise<WorkerDelivery> {
		const current = await this.store.readWorkerDelivery(delivery.deliveryId);
		if (!current) throw error;
		if (current.status === "consumed") return current;
		const failed = await this.store.updateWorkerDelivery(delivery.deliveryId, {
			// Once Runtime may have accepted it, preserve that uncertainty for reconciliation.
			status: current.status === "accepted" || current.status === "dispatched" ? current.status : "failed",
			error: error instanceof Error ? error.message : String(error),
			updatedAt: Date.now(),
		});
		if (failed.status === "failed") {
			const message = await this.getWorkerMessage(failed.messageId);
			if (message.sourceSessionId && (message.kind === "request" || message.kind === "question"))
				await this.enqueueWorkerMessage({
					messageId: `worker-failure:${createHash("sha256").update(message.messageId).digest("hex")}`,
					workerId: message.sourceWorkerId,
					sourceWorkerId: message.workerId,
					sourceSessionId: failed.sessionId ?? message.targetSessionId,
					targetSessionId: message.sourceSessionId,
					workId: message.workId,
					replyTo: message.messageId,
					kind: "result",
					content: `Worker 消息未执行：${failed.error?.slice(0, 1000) ?? "投递失败"}`,
					mode: message.mode,
				});
		}
		return failed;
	}
}
