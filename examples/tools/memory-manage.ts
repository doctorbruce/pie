import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolContext } from "@pie/server/tools";

// Adapted from Astron's adapters/opencode/tools/tool_assets/memory-manage.ts.
export default function createMemoryTool({ Type, sessionId, env }: ToolContext) {
	const parameters = Type.Object(
		{
			action: Type.Optional(Type.Union([Type.Literal("list"), Type.Literal("add"), Type.Literal("delete")])),
			scope: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("assistant")])),
			topic: Type.Optional(
				Type.Union([Type.Literal("preferences"), Type.Literal("feedback"), Type.Literal("facts")]),
			),
			text: Type.Optional(Type.String({ description: "add 时要保存的单条长期记忆，不能包含敏感或临时信息。" })),
			category: Type.Optional(Type.String()),
			entryId: Type.Optional(Type.String({ description: "delete 时要删除的记忆 ID。" })),
			assistantId: Type.Optional(Type.String({ description: "Astron 助手 ID；不要编造或填写其他助手。" })),
		},
		{ additionalProperties: false },
	);
	const tool: AgentTool<typeof parameters, Record<string, unknown>> = {
		name: "memory-manage",
		label: "Astron 记忆管理",
		description: [
			"管理 Astron 长期记忆，通过 Astron Engine 本地记忆 API 操作。支持 list/add/delete。",
			"用户明确要求记住、保存偏好、以后都这样、别再这样，或需要查看/删除记忆时使用。",
			"只保存稳定的用户偏好、反馈和助手事实；不要保存模型/工具能力、一次性进度、搜索结果、密钥或系统提示。",
			"add 仍经过 Astron 的安全过滤，拒绝时返回 MEMORY_REJECTED。本工具不审批 pending 项。",
		].join(" "),
		parameters,
		async execute(_callId, args, signal, onUpdate) {
			const base =
				env.ASTRON_RPA_ROUTE_BASE_URL?.trim() ||
				(env.ASTRON_RPA_ROUTE_PORT?.trim() ? `http://127.0.0.1:${env.ASTRON_RPA_ROUTE_PORT.trim()}` : "");
			if (!base) throw new Error("缺少 ASTRON_RPA_ROUTE_BASE_URL 或 ASTRON_RPA_ROUTE_PORT");
			const action = args.action ?? "list";
			const assistantId = args.assistantId?.trim() || null;
			const scope = args.scope ?? null;
			let path = "/agent/memories/entries";
			let method = "GET";
			let body: Record<string, unknown> | undefined;
			if (action === "list") {
				const query = new URLSearchParams();
				if (assistantId) query.set("assistantId", assistantId);
				if (scope !== "user") query.set("sessionId", sessionId);
				if (query.size) path += `?${query}`;
			} else if (action === "add") {
				const text = args.text?.trim();
				if (!text || !scope || !args.topic) throw new Error("新增记忆需要 scope、topic 和非空 text");
				if ((scope === "user" && args.topic === "facts") || (scope === "assistant" && args.topic === "preferences"))
					throw new Error("user 支持 preferences/feedback；assistant 支持 facts/feedback");
				method = "POST";
				body = {
					scope,
					assistantId: assistantId ?? undefined,
					topic: args.topic,
					text,
					category: args.category?.trim() || undefined,
					origin: "agent_tool",
					sourceSessionId: sessionId,
				};
			} else {
				const entryId = args.entryId?.trim();
				if (!entryId) throw new Error("删除记忆需要 entryId");
				method = "DELETE";
				path += `/${encodeURIComponent(entryId)}`;
			}
			const details: Record<string, unknown> = {
				requestType: "memory_manage",
				action,
				scope,
				assistantId,
				sessionId,
			};
			onUpdate?.({
				content: [
					{ type: "text", text: `正在${action === "list" ? "读取" : action === "add" ? "保存" : "删除"}记忆…` },
				],
				details,
			});
			const response = await fetch(`${base.replace(/\/$/, "")}${path}`, {
				method,
				headers: body ? { "Content-Type": "application/json" } : undefined,
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(30000)]),
				redirect: "error",
			});
			const result: unknown = await response.json();
			if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("记忆服务返回格式无效");
			const envelope = result as Record<string, unknown>;
			if (
				!response.ok ||
				(envelope.code !== undefined && !["0000", 0, 200].includes(envelope.code as string | number))
			) {
				const reason =
					envelope.reason || envelope.error || envelope.message || envelope.msg || `HTTP ${response.status}`;
				throw new Error(`${envelope.code ? `${envelope.code}: ` : ""}${reason}`);
			}
			const data = envelope.data ?? envelope;
			if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("记忆服务返回格式无效");
			const source = data as Record<string, unknown>;
			let output: Record<string, unknown>;
			if (action === "list") {
				const entries = Array.isArray(source.entries) ? source.entries : [];
				details.count = entries.length;
				output = { status: "success", action, assistantId: source.assistantId ?? null, entries };
			} else if (action === "add") {
				const status = source.duplicate === true ? "duplicate" : source.written === true ? "saved" : "not_written";
				details.status = status;
				details.topic = args.topic;
				output = {
					status,
					action,
					entry: source.entry ?? null,
					duplicate: source.duplicate === true,
					decision: source.decision ?? null,
				};
			} else {
				const status = source.deleted === true ? "deleted" : "not_found";
				details.status = status;
				details.entryId = args.entryId?.trim();
				output = { status, action, entry: source.entry ?? null };
			}
			return { content: [{ type: "text", text: JSON.stringify(output, null, 2) }], details };
		},
	};
	return tool;
}
