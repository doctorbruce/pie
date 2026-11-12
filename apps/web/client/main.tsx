import {
	ActionBarPrimitive,
	AssistantRuntimeProvider,
	MessagePrimitive,
	type ReasoningMessagePartProps,
	type ThreadMessageLike,
	ThreadPrimitive,
	type ToolCallMessagePartProps,
	useExternalStoreRuntime,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type {
	Assistant,
	InteractionRequest,
	ModelSelection,
	ProviderCatalog,
	ServerInfo,
	SessionEvent,
	SessionForkResult,
	SessionHistoryPage,
	SessionSnapshot,
	SessionSummary,
	SessionTransfer,
	SessionTree,
	ToolActivity,
} from "@pie/runtime/protocol";
import { messageIdentity, prependHistoryPage } from "@pie/runtime/session-events";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantSettings } from "./assistant-settings.tsx";
import { Composer, type Draft } from "./composer.tsx";
import { toThreadMessages, updateToolProgress } from "./messages.ts";
import { ModelSettings } from "./model-settings.tsx";
import { PluginSettings } from "./plugin-settings.tsx";
import { request } from "./request.ts";
import { connectSession } from "./session-connection.ts";
import { BackgroundJobs } from "./session-jobs.tsx";
import { SessionModelSelect } from "./session-model.tsx";
import { SessionTreeDialog } from "./session-tree.tsx";
import { store, stored } from "./storage.ts";
import { createTurnSender } from "./turn-submission.ts";
import "./style.css";

function Reasoning({ text }: ReasoningMessagePartProps) {
	return (
		<details className="reasoning">
			<summary>思考过程</summary>
			<div>{text}</div>
		</details>
	);
}

function Tool({
	toolName,
	argsText,
	result,
	isError,
	status,
	artifact,
}: ToolCallMessagePartProps<Record<string, unknown>, unknown>) {
	const running = status.type === "running";
	return (
		<details className={`tool-card ${isError ? "is-error" : ""}`} open={running || isError}>
			<summary>
				<span className={`tool-state ${running ? "is-running" : ""}`} />
				<span>{toolName}</span>
				<small>{isError ? "失败" : result !== undefined ? "已完成" : running ? "执行中" : "未完成"}</small>
				<span className="chevron">⌄</span>
			</summary>
			<div className="tool-detail">
				<span className="tool-detail-label">输入</span>
				<pre>{argsText}</pre>
				{typeof artifact === "string" && (
					<>
						<span className="tool-detail-label">进度</span>
						<pre>{artifact}</pre>
					</>
				)}
				{result !== undefined && (
					<>
						<span className="tool-detail-label">输出</span>
						<pre>{typeof result === "string" ? result : JSON.stringify(result, null, 2)}</pre>
					</>
				)}
			</div>
		</details>
	);
}

function UserMessage() {
	return (
		<MessagePrimitive.Root className="message user-message">
			<div className="message-content">
				<MessagePrimitive.Parts />
				<ActionBarPrimitive.Root className="message-actions">
					<ActionBarPrimitive.Copy aria-label="复制消息">复制</ActionBarPrimitive.Copy>
				</ActionBarPrimitive.Root>
			</div>
		</MessagePrimitive.Root>
	);
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="message assistant-message">
			<div className="assistant-badge">P</div>
			<div className="message-content">
				<MessagePrimitive.Parts components={{ Text: Markdown, Reasoning, tools: { Fallback: Tool } }} />
				<MessagePrimitive.Error>
					<p className="message-error">回复未完成，请查看下方状态并重试。</p>
				</MessagePrimitive.Error>
				<ActionBarPrimitive.Root className="message-actions">
					<ActionBarPrimitive.Copy aria-label="复制回复">复制</ActionBarPrimitive.Copy>
				</ActionBarPrimitive.Root>
			</div>
		</MessagePrimitive.Root>
	);
}

function Markdown() {
	return <MarkdownTextPrimitive />;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function InteractionPrompt({
	interaction,
	disabled,
	error,
	canStop,
	onStop,
	onReply,
}: {
	interaction: InteractionRequest;
	disabled: boolean;
	error: string;
	canStop: boolean;
	onStop: () => void;
	onReply: (approved: boolean, remember: boolean) => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [remember, setRemember] = useState(false);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	const display = isRecord(interaction.metadata?.display) ? interaction.metadata.display : {};
	const card = isRecord(display.previewCard) ? display.previewCard : {};
	const items = Array.isArray(card.items) ? card.items.filter(isRecord) : [];
	return (
		<dialog
			ref={dialog}
			className="confirm-dialog"
			aria-labelledby="interaction-title"
			onCancel={(event) => event.preventDefault()}
		>
			<div className="dialog-mark">!</div>
			<div>
				<span className="dialog-kicker">需要你的确认</span>
				<h2 id="interaction-title">{interaction.title}</h2>
				<p>{interaction.message}</p>
				{error && (
					<p className="message-error" role="alert">
						{error}
					</p>
				)}
				{items.length > 0 && (
					<dl className="interaction-preview">
						{items.map((item, index) => (
							<div key={`${String(item.label)}:${index}`}>
								<dt>{String(item.label || "信息")}</dt>
								<dd>{String(item.value || "—")}</dd>
							</div>
						))}
					</dl>
				)}
				{interaction.remember && (
					<label className="settings-checkbox">
						<input
							type="checkbox"
							checked={remember}
							onChange={(event) => setRemember(event.target.checked)}
							disabled={disabled}
						/>
						本会话记住此范围：{interaction.remember.patterns.join("、")}
					</label>
				)}
				<div className="dialog-actions">
					{canStop && (
						<button type="button" disabled={disabled} onClick={onStop}>
							停止本次执行
						</button>
					)}
					<button type="button" disabled={disabled} onClick={() => onReply(false, false)}>
						拒绝
					</button>
					<button
						type="button"
						className="confirm-button"
						disabled={disabled}
						onClick={() => onReply(true, remember)}
					>
						{disabled ? "处理中…" : "确认并继续"}
					</button>
				</div>
			</div>
		</dialog>
	);
}

function relativeTime(value: number) {
	const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
	if (seconds < 60) return "刚刚";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

const activityLabels: Record<ToolActivity["status"], string> = {
	running: "处理中",
	succeeded: "已完成",
	failed: "失败",
	cancelled: "已取消",
	unknown: "状态未知",
};

function App() {
	const [selectedModel, setSelectedModel] = useState<ModelSelection>();
	const [snapshot, setSnapshot] = useState<SessionSnapshot>();
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [assistants, setAssistants] = useState<Assistant[]>([]);
	const [assistantId, setAssistantId] = useState("");
	const [query, setQuery] = useState("");
	const [toolProgress, setToolProgress] = useState<ReadonlyMap<string, string>>(new Map());
	const [coreReady, setCoreReady] = useState(false);
	const [connected, setConnected] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [showSidebar, setShowSidebar] = useState(false);
	const [showDetails, setShowDetails] = useState(false);
	const [showModelSettings, setShowModelSettings] = useState(false);
	const [showPluginSettings, setShowPluginSettings] = useState(false);
	const [assistantEditor, setAssistantEditor] = useState<Assistant | "new">();
	const [replyingInteractionId, setReplyingInteractionId] = useState<string>();
	const [loadingSession, setLoadingSession] = useState(false);
	const [loadingHistory, setLoadingHistory] = useState(false);
	const [archived, setArchived] = useState(false);
	const [tree, setTree] = useState<SessionTree>();
	const [initialDraft, setInitialDraft] = useState<Draft>();
	const [notice, setNotice] = useState("");
	const [connectionEpoch, setConnectionEpoch] = useState(0);
	const [draftVersion, setDraftVersion] = useState(0);
	const [interactionError, setInteractionError] = useState("");
	const [modelRevision, setModelRevision] = useState(0);
	const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 760px)").matches);
	const sidebarWasOpen = useRef(false);
	const sidebarToggle = useRef<HTMLButtonElement>(null);
	const selection = useRef(0);
	const operation = useRef(false);
	const initialized = useRef(false);
	const initializing = useRef(false);
	const turnSender = useRef(createTurnSender());
	const viewport = useRef<HTMLDivElement>(null);
	const sessionRef = useRef<SessionSnapshot | undefined>(undefined);
	const busy = snapshot?.turn?.status === "running";
	const interrupted = snapshot?.turn?.status === "interrupted";

	const accept = useCallback((next: SessionSnapshot) => {
		const previous = sessionRef.current;
		if (previous?.id !== next.id) return;
		if (previous.instanceId === next.instanceId && previous.revision > next.revision) return;
		sessionRef.current = next;
		setSnapshot(next);
	}, []);

	const refreshSessions = useCallback(async () => {
		const result = await request<{ sessions: SessionSummary[] }>("/sessions?includeArchived=true");
		const visible = result.sessions
			.filter((session) => session.kind === "root")
			.sort((left, right) => right.updatedAt - left.updatedAt);
		setSessions(visible);
		return visible;
	}, []);

	const activate = useCallback((next?: SessionSnapshot) => {
		sessionRef.current = next;
		setSnapshot(next);
		setToolProgress(new Map());
		setConnected(false);
		setConnectionEpoch((value) => value + 1);
		setInitialDraft(undefined);
		setTree(undefined);
		if (next) {
			setAssistantId(next.assistantId);
			store("pie.web.session", next.id);
		} else store("pie.web.session", "");
	}, []);

	const initialize = useCallback(async () => {
		if (initializing.current) return;
		initializing.current = true;
		setPending(true);
		setError("");
		const ticket = ++selection.current;
		try {
			await request<ServerInfo>("/health");
			setCoreReady(true);
			const [catalog, assistantCatalog, allSessions] = await Promise.all([
				request<ProviderCatalog>("/providers"),
				request<{ assistants: Assistant[] }>("/assistants"),
				refreshSessions(),
			]);
			setSelectedModel(catalog.selected);
			setAssistants(assistantCatalog.assistants);
			setAssistantId(assistantCatalog.assistants[0]?.id ?? "");
			const savedId = stored("pie.web.session");
			const existing =
				allSessions.find((session) => session.id === savedId) ?? allSessions.find((session) => !session.archived);
			const next = existing ? await request<SessionSnapshot>(`/sessions/${existing.id}?limit=50`) : undefined;
			if (ticket === selection.current) activate(next);
			initialized.current = true;
		} catch (reason) {
			setCoreReady(false);
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			initializing.current = false;
			setPending(false);
		}
	}, [activate, refreshSessions]);

	useEffect(() => {
		void initialize();
	}, [initialize]);
	useEffect(() => {
		if (!snapshot || busy || pending || snapshot.title !== "新会话") return;
		const title = stored(`pie.title.${snapshot.id}`);
		if (!title) return;
		store(`pie.title.${snapshot.id}`, "");
		void request<SessionSnapshot>(`/sessions/${snapshot.id}`, "PATCH", { title })
			.then((next) => {
				accept(next);
				return refreshSessions();
			})
			.catch(() => {});
	}, [accept, busy, pending, refreshSessions, snapshot]);
	useEffect(() => {
		const media = window.matchMedia("(max-width: 760px)");
		const resize = () => setNarrow(media.matches);
		media.addEventListener("change", resize);
		return () => media.removeEventListener("change", resize);
	}, []);
	useEffect(() => {
		if (narrow && showSidebar) document.getElementById("session-search")?.focus();
		else if (narrow && sidebarWasOpen.current) sidebarToggle.current?.focus();
		sidebarWasOpen.current = narrow && showSidebar;
	}, [narrow, showSidebar]);
	useEffect(() => {
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !document.querySelector("dialog[open]")) {
				setShowSidebar(false);
				setShowDetails(false);
			}
		};
		window.addEventListener("keydown", handleEscape);
		return () => window.removeEventListener("keydown", handleEscape);
	}, []);
	useEffect(() => {
		const timer = setInterval(() => {
			if (!initialized.current) {
				void initialize();
				return;
			}
			void request<ServerInfo>("/health")
				.then(() => {
					setCoreReady(true);
					return refreshSessions();
				})
				.catch(() => setCoreReady(false));
		}, 5000);
		return () => clearInterval(timer);
	}, [initialize, refreshSessions]);
	useEffect(() => {
		const sessionId = snapshot?.id;
		if (!sessionId || !connectionEpoch) return;
		return connectSession(sessionId, {
			getSnapshot: () => sessionRef.current,
			onSnapshot: accept,
			onConnection: setConnected,
			onError: (reason) => setError(reason.message),
			onEvent: (packet: SessionEvent) => {
				setToolProgress((current) => updateToolProgress(current, packet));
				if (packet.type === "turn.settled") void refreshSessions().catch(() => {});
			},
		});
	}, [accept, refreshSessions, snapshot?.id, connectionEpoch]);

	function switchSession(next?: SessionSnapshot) {
		selection.current++;
		activate(next);
		setShowSidebar(false);
		setShowDetails(false);
		setError("");
		setNotice("");
		setLoadingSession(false);
	}
	async function openSession(id: string) {
		const ticket = ++selection.current;
		setLoadingSession(true);
		setError("");
		try {
			const next = await request<SessionSnapshot>(`/sessions/${id}?limit=50`);
			if (ticket === selection.current) switchSession(next);
		} catch (reason) {
			if (ticket === selection.current) setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			if (ticket === selection.current) setLoadingSession(false);
		}
	}

	async function send(draft: Draft): Promise<boolean> {
		const current = sessionRef.current;
		const action = current?.execution.actions[busy ? "steer" : "submit"];
		if (
			!current ||
			!connected ||
			operation.current ||
			!action?.available ||
			(!draft.text.trim() && !draft.images.length)
		)
			return false;
		operation.current = true;
		setPending(true);
		setError("");
		try {
			const reconciled = await turnSender.current.send(current, draft);
			if (reconciled) accept(reconciled);
			if (!busy && current.title === "新会话" && draft.text.trim()) {
				// Runtime prohibits renaming a running session. Apply after it settles.
				store(`pie.title.${current.id}`, draft.text.trim().replace(/\s+/g, " ").slice(0, 40));
			}
			return true;
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
			return false;
		} finally {
			operation.current = false;
			setPending(false);
		}
	}

	async function cancel() {
		const current = sessionRef.current;
		if (!current?.turn || !current.execution.actions.cancel.available || operation.current) return;
		operation.current = true;
		setPending(true);
		try {
			await request(`/sessions/${current.id}/cancel`, "POST", { turnId: current.turn.id });
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			operation.current = false;
			setPending(false);
		}
	}

	async function resume() {
		const current = sessionRef.current;
		if (!current?.turn || !current.execution.actions.resume.available || operation.current) return;
		operation.current = true;
		setPending(true);
		try {
			await request(`/sessions/${current.id}/resume`, "POST", { turnId: current.turn.id });
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			operation.current = false;
			setPending(false);
		}
	}

	async function newSession(mode: "real" | "faux" = "real") {
		if (pending || !assistantId) return;
		if (mode === "real" && !selectedModel) {
			setShowModelSettings(true);
			return;
		}
		setPending(true);
		setError("");
		try {
			const next = await request<SessionSnapshot>("/sessions", "POST", {
				assistantId,
				mode,
				model: mode === "real" ? selectedModel : undefined,
			});
			switchSession(next);
			await refreshSessions();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setPending(false);
		}
	}

	async function replyToInteraction(approved: boolean, remember: boolean) {
		const current = sessionRef.current;
		const interaction = current?.interactions[0];
		if (!current || !interaction || replyingInteractionId) return;
		setReplyingInteractionId(interaction.id);
		setInteractionError("");
		try {
			await request(`/sessions/${current.id}/interactions/${interaction.id}`, "POST", { approved, remember });
		} catch (reason) {
			setInteractionError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setReplyingInteractionId(undefined);
		}
	}
	async function loadHistory() {
		const current = sessionRef.current;
		const before = current?.history?.nextBeforeSeq;
		if (!current || before == null || loadingHistory) return;
		setLoadingHistory(true);
		const height = viewport.current?.scrollHeight ?? 0;
		const top = viewport.current?.scrollTop ?? 0;
		try {
			const page = await request<SessionHistoryPage>(
				`/sessions/${current.id}/history?limit=50&beforeSeq=${before}&leafId=${encodeURIComponent(String(current.history?.leafId))}`,
			);
			if (sessionRef.current?.id !== current.id) return;
			accept(prependHistoryPage(sessionRef.current, page, before));
			requestAnimationFrame(() => {
				if (viewport.current) viewport.current.scrollTop = top + viewport.current.scrollHeight - height;
			});
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLoadingHistory(false);
		}
	}
	async function manage(action: string, body?: unknown, method = "POST") {
		const current = sessionRef.current;
		if (!current || pending) return;
		setPending(true);
		setError("");
		try {
			await request(`/sessions/${current.id}${action}`, method, body);
			const next = await request<SessionSnapshot>(`/sessions/${current.id}?limit=50`);
			accept(next);
			await refreshSessions();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setPending(false);
		}
	}
	async function retryLastMessage() {
		const current = sessionRef.current;
		const user = current ? [...current.messages].reverse().find((message) => message.role === "user") : undefined;
		if (!current || user?.role !== "user" || pending) return;
		setPending(true);
		setError("");
		try {
			const result = await request<SessionForkResult>(`/sessions/${current.id}/fork`, "POST", {
				beforeMessageId: messageIdentity(user),
			});
			switchSession(result.session);
			setInitialDraft({
				text: result.selectedText,
				images: typeof user.content === "string" ? [] : user.content.filter((part) => part.type === "image"),
			});
			setDraftVersion((value) => value + 1);
			setNotice("已创建分支并恢复上一条消息；检查后发送。原会话及已发生的工具操作会保留。");
			await refreshSessions();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setPending(false);
		}
	}
	async function openTree() {
		if (!snapshot || pending) return;
		const ticket = selection.current;
		setPending(true);
		try {
			const next = await request<SessionTree>(`/sessions/${snapshot.id}/tree`);
			if (ticket === selection.current) setTree(next);
		} catch (reason) {
			if (ticket === selection.current) setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setPending(false);
		}
	}
	async function selectBranch(entryId: string) {
		if (!snapshot || pending) return;
		setPending(true);
		try {
			const selected = tree?.entries.find((entry) => entry.id === entryId);
			let images: Draft["images"] = [];
			if (selected?.role === "user") {
				// Select the node's own path, including images on inactive branches.
				const page = await request<SessionHistoryPage>(
					`/sessions/${snapshot.id}/history?limit=1&leafId=${encodeURIComponent(selected.id)}`,
				);
				const message = page.entries.find((entry) => entry.id === selected.id)?.message;
				if (message?.role === "user" && typeof message.content !== "string")
					images = message.content.filter((part) => part.type === "image");
			}
			const result = await request<SessionForkResult>(`/sessions/${snapshot.id}/tree`, "POST", { entryId });
			activate(result.session);
			setInitialDraft({ text: result.selectedText, images });
			setDraftVersion((value) => value + 1);
			setTree(undefined);
			await refreshSessions();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setPending(false);
		}
	}
	async function exportChat() {
		if (!snapshot) return;
		try {
			const data = await request<SessionTransfer>(`/sessions/${snapshot.id}/export`);
			const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
			const anchor = document.createElement("a");
			anchor.href = url;
			anchor.download = `pie-${snapshot.id}.json`;
			anchor.click();
			URL.revokeObjectURL(url);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}
	async function deleteChat() {
		if (!snapshot || !window.confirm(`永久删除「${snapshot.title}」及其子会话？此操作无法撤销。`)) return;
		setPending(true);
		try {
			await request(`/sessions/${snapshot.id}`, "DELETE");
			switchSession();
			await refreshSessions();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setPending(false);
		}
	}

	const messages = useMemo(() => toThreadMessages(snapshot, toolProgress), [snapshot, toolProgress]);
	const runtime = useExternalStoreRuntime({
		messages,
		convertMessage: (message: ThreadMessageLike) => message,
		isRunning: Boolean(busy),
		isDisabled: !connected || pending || Boolean(interrupted),
		onNew: async (message) => {
			await send({
				text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
				images: [],
			});
		},
		onCancel: cancel,
	});
	const currentAssistant = assistants.find((assistant) => assistant.id === assistantId);
	const visibleSessions = sessions.filter(
		(session) =>
			Boolean(session.archived) === archived &&
			`${session.title} ${assistants.find((assistant) => assistant.id === session.assistantId)?.name ?? ""}`
				.toLowerCase()
				.includes(query.trim().toLowerCase()),
	);
	const connectionLabel = !coreReady
		? "Core 离线"
		: busy
			? "正在处理"
			: snapshot && !connected
				? "正在重连"
				: "Core 已连接";

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<div className={`app-shell ${showSidebar ? "show-sidebar" : ""}`}>
				{showSidebar && (
					<button
						type="button"
						className="sidebar-scrim"
						aria-label="关闭导航"
						onClick={() => setShowSidebar(false)}
					/>
				)}
				<aside className="sidebar" inert={narrow && !showSidebar}>
					<header className="sidebar-header">
						<button
							type="button"
							className="brand-button"
							aria-label="Pie 首页"
							disabled={pending}
							onClick={() => switchSession()}
						>
							<span className="brand-mark">P</span>
							<strong>Pie</strong>
						</button>
						<div className="sidebar-actions">
							<button
								type="button"
								className="circle-button"
								aria-label="搜索会话"
								onClick={() => document.getElementById("session-search")?.focus()}
							>
								⌕
							</button>
							<button
								type="button"
								className="circle-button add-button"
								aria-label="新建对话"
								disabled={pending || !coreReady}
								onClick={() => void newSession()}
							>
								＋
							</button>
						</div>
					</header>
					<div className="assistant-strip">
						<span className="assistant-avatar">P</span>
						<select
							id="assistant-select"
							aria-label="当前助手"
							value={assistantId}
							disabled={pending}
							onChange={(event) => {
								const id = event.target.value;
								switchSession();
								setAssistantId(id);
								const latest = sessions.find((session) => session.assistantId === id);
								if (latest) void openSession(latest.id);
							}}
						>
							{assistants.map((assistant) => (
								<option key={assistant.id} value={assistant.id}>
									{assistant.name}
								</option>
							))}
						</select>
						<button
							type="button"
							className="plain-icon"
							aria-label="编辑助手"
							disabled={!currentAssistant}
							onClick={() => setAssistantEditor(currentAssistant)}
						>
							•••
						</button>
					</div>
					<div className="group-heading">
						<span>
							{archived ? "已归档" : "全部会话"} · {visibleSessions.length}
						</span>
						<button
							type="button"
							className="event-toggle"
							aria-label={archived ? "返回最近会话" : "查看归档"}
							onClick={() => setArchived(!archived)}
						>
							{archived ? "返回" : "归档"}
						</button>
					</div>
					<label className="session-search">
						<span>⌕</span>
						<input
							id="session-search"
							value={query}
							aria-label="搜索对话"
							placeholder="搜索对话"
							onChange={(event) => setQuery(event.target.value)}
						/>
					</label>
					<nav className="session-list" aria-label="对话列表">
						<div className="session-section-label">最近对话</div>
						{visibleSessions.map((session) => (
							<button
								type="button"
								key={session.id}
								className={`session-row ${session.id === snapshot?.id ? "active" : ""}`}
								disabled={pending}
								onClick={() => void openSession(session.id)}
								aria-current={session.id === snapshot?.id ? "page" : undefined}
							>
								<span className="session-icon">{session.title.slice(0, 1).toUpperCase() || "P"}</span>
								<span className="session-copy">
									<strong>{session.title}</strong>
									<small>
										{session.turn?.status === "running" ? "正在处理" : relativeTime(session.updatedAt)}
									</small>
								</span>
								{session.id === snapshot?.id && <span className="session-active-dot" />}
							</button>
						))}
						{visibleSessions.length === 0 && (
							<p className="empty-list">
								{query ? "没有匹配的对话" : archived ? "暂无归档对话" : "还没有对话，点击右上角 ＋ 创建。"}
							</p>
						)}
					</nav>
					<footer className="sidebar-footer">
						<button type="button" onClick={() => setAssistantEditor("new")}>
							＋ 新建助手
						</button>
						<button type="button" onClick={() => setShowPluginSettings(true)}>
							插件
						</button>
						<button type="button" onClick={() => setShowModelSettings(true)}>
							设置
						</button>
					</footer>
				</aside>
				<main className="workspace" inert={narrow && showSidebar}>
					<header className="chat-header">
						<button
							ref={sidebarToggle}
							type="button"
							className="circle-button mobile-only"
							aria-label="打开导航"
							aria-expanded={showSidebar}
							onClick={() => setShowSidebar(true)}
						>
							☰
						</button>
						<div className="chat-title">
							<strong>{snapshot?.title ?? currentAssistant?.name ?? "Pie"}</strong>
							<span>
								<i className={coreReady && (!snapshot || connected) ? "online" : ""} />
								{connectionLabel}
							</span>
						</div>
						<div className="chat-actions">
							<button
								type="button"
								className="model-pill"
								title="模型设置（新会话默认）"
								onClick={() => setShowModelSettings(true)}
							>
								{snapshot?.mode === "faux"
									? "本地试用 · 无模型调用"
									: (snapshot?.model ?? selectedModel?.id ?? "配置模型")}
							</button>
							<button
								type="button"
								className="circle-button"
								aria-label="打开会话详情"
								onClick={() => setShowDetails((current) => !current)}
							>
								•••
							</button>
						</div>
					</header>
					{error && (
						<div className="banner error" role="alert">
							<span>{error}</span>
							<button type="button" onClick={() => void initialize()} disabled={pending}>
								重新连接
							</button>
							<button type="button" aria-label="关闭错误" onClick={() => setError("")}>
								×
							</button>
						</div>
					)}
					{notice && (
						<output className="notice">
							{notice}
							<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}>
								×
							</button>
						</output>
					)}
					{loadingSession && <output className="loading-state">正在加载会话…</output>}
					<ThreadPrimitive.Root key={snapshot?.id ?? "empty"} className="thread">
						<ThreadPrimitive.Viewport ref={viewport} className="viewport">
							{snapshot?.history?.nextBeforeSeq != null && (
								<button
									type="button"
									className="history-button"
									disabled={loadingHistory}
									onClick={() => void loadHistory()}
								>
									{loadingHistory ? "正在加载…" : "加载更早消息"}
								</button>
							)}
							{messages.length === 0 && (
								<section className="welcome">
									<div className="welcome-orb">
										<span>P</span>
									</div>
									<h1>{snapshot ? "有什么我可以帮你？" : "开始一个新对话"}</h1>
									<p>
										{selectedModel
											? "描述一个想法、问题或任务，Pie 会和你一起完成。"
											: "先在设置中配置模型，再创建第一个对话。"}
									</p>
									{snapshot && (
										<div className="suggestions">
											{[
												["整理思路", "帮我把现在的想法整理成可执行计划"],
												["分析项目", "分析当前项目，指出最值得先做的三件事"],
												["开始任务", "先问我必要信息，然后开始完成任务"],
											].map(([label, prompt]) => (
												<button
													key={label}
													type="button"
													disabled={!connected || Boolean(busy)}
													onClick={() => void send({ text: prompt, images: [] })}
												>
													<strong>{label}</strong>
													<span>{prompt}</span>
												</button>
											))}
										</div>
									)}
									{!snapshot && selectedModel && (
										<button type="button" className="welcome-action" onClick={() => void newSession()}>
											创建新对话
										</button>
									)}
									{!selectedModel && (
										<button
											type="button"
											className="welcome-action"
											onClick={() => setShowModelSettings(true)}
										>
											配置模型
										</button>
									)}
									{!snapshot && (
										<button
											type="button"
											className="local-trial"
											disabled={pending || !coreReady}
											onClick={() => void newSession("faux")}
										>
											本地试用 · 不调用模型
										</button>
									)}
								</section>
							)}
							<div className="transcript">
								<ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
								{busy && (
									<output className="running-indicator">
										{snapshot?.execution.cancellationRequested
											? "正在停止并清理工具…"
											: snapshot?.execution.waitingForInteraction
												? "等待你的确认"
												: snapshot?.execution.activeTools.length
													? `正在执行 ${snapshot.execution.activeTools.map((tool) => tool.toolName).join("、")}`
													: "Pie 正在思考…"}
									</output>
								)}
							</div>
						</ThreadPrimitive.Viewport>
						{messages.length > 0 && (
							<ThreadPrimitive.ScrollToBottom className="scroll-bottom" aria-label="回到最新消息">
								↓ 最新消息
							</ThreadPrimitive.ScrollToBottom>
						)}
						{snapshot && (
							<div className="composer-area">
								{snapshot.turn && snapshot.turn.status !== "running" && (
									<output className={`turn-status ${snapshot.turn.status}`}>
										{snapshot.turn.status === "failed"
											? snapshot.turn.error
											: snapshot.turn.status === "cancelled"
												? "本次执行已停止"
												: interrupted
													? "执行已中断，可继续本次对话"
													: snapshot.execution.waitingForMessage
														? "正在等待后台消息"
														: "本轮回复已结束"}
									</output>
								)}
								{interrupted && (
									<div className="resume-actions">
										<button
											type="button"
											disabled={!connected || pending || !snapshot.execution.actions.cancel.available}
											onClick={() => void cancel()}
										>
											停止
										</button>
										<button
											type="button"
											className="confirm-button"
											disabled={!connected || pending || !snapshot.execution.actions.resume.available}
											onClick={() => void resume()}
										>
											继续
										</button>
									</div>
								)}
								{snapshot.execution.recoveryBlockedReason && (
									<p className="turn-status failed">{snapshot.execution.recoveryBlockedReason}</p>
								)}
								{!busy && !interrupted && messages.length > 0 && (
									<div className="resume-actions">
										<button
											type="button"
											disabled={pending || !connected}
											onClick={() => void retryLastMessage()}
										>
											重试 / 编辑上一条（新分支）
										</button>
									</div>
								)}
								<Composer
									key={`${snapshot.id}:${draftVersion}`}
									sessionId={snapshot.id}
									initialDraft={initialDraft}
									disabled={
										!connected ||
										loadingSession ||
										(!snapshot.execution.actions.submit.available &&
											!snapshot.execution.actions.steer.available)
									}
									pending={pending}
									running={Boolean(busy)}
									canStop={snapshot.execution.actions.cancel.available}
									canSteer={snapshot.execution.actions.steer.available}
									onSend={send}
									onStop={() => void cancel()}
								/>
								<p className="disclaimer">Pie 可能会出错，请检查重要信息。</p>
							</div>
						)}
					</ThreadPrimitive.Root>
				</main>
				{showDetails && (
					<aside className="details-panel">
						<header>
							<div>
								<span className="dialog-kicker">SESSION</span>
								<h2>会话详情</h2>
							</div>
							<button type="button" className="circle-button" onClick={() => setShowDetails(false)}>
								×
							</button>
						</header>
						{snapshot ? (
							<>
								{snapshot.mode === "real" && (
									<section>
										<SessionModelSelect
											key={`${snapshot.id}:${modelRevision}`}
											session={snapshot}
											disabled={pending}
											onSaved={accept}
										/>
									</section>
								)}
								<section key={`${snapshot.id}:${snapshot.title}`}>
									<form
										className="session-form"
										onSubmit={(event) => {
											event.preventDefault();
											const data = new FormData(event.currentTarget);
											void manage("", { title: data.get("title") }, "PATCH");
										}}
									>
										<label>
											会话标题
											<input
												name="title"
												required
												maxLength={100}
												defaultValue={snapshot.title}
												disabled={pending || busy}
											/>
										</label>
										<button className="event-toggle" type="submit" disabled={pending || busy}>
											保存标题
										</button>
									</form>
									<form
										className="session-form"
										onSubmit={(event) => {
											event.preventDefault();
											const data = new FormData(event.currentTarget);
											void manage(
												"/workspace",
												{ workspacePath: String(data.get("workspacePath") ?? "").trim() },
												"PUT",
											);
										}}
									>
										<label>
											工作目录
											<input
												name="workspacePath"
												required
												maxLength={4096}
												defaultValue={snapshot.workspacePath ?? ""}
												placeholder="例如 /workspace/project"
												disabled={pending || !snapshot.execution.actions.submit.available}
											/>
										</label>
										<button
											className="event-toggle"
											type="submit"
											disabled={pending || !snapshot.execution.actions.submit.available}
										>
											保存工作目录
										</button>
									</form>
									<button
										type="button"
										className="event-toggle"
										disabled={pending || busy || Boolean(interrupted)}
										onClick={() => void openTree()}
									>
										查看会话分支
									</button>
									<button
										type="button"
										className="event-toggle"
										disabled={pending || busy}
										onClick={() => void exportChat()}
									>
										导出会话 JSON
									</button>
									<button
										type="button"
										className="event-toggle"
										disabled={pending}
										onClick={() => void manage("/archive", { archived: !snapshot.archived })}
									>
										{snapshot.archived ? "取消归档" : "归档会话"}
									</button>
									<button
										type="button"
										className="event-toggle danger"
										disabled={pending || busy || Boolean(interrupted)}
										onClick={() => void deleteChat()}
									>
										删除会话
									</button>
								</section>
								<section>
									<span className="detail-label">助手</span>
									<strong>{snapshot.assistant?.name ?? snapshot.assistantId}</strong>
									<span className="detail-label">模型</span>
									<strong>
										{snapshot.provider ? `${snapshot.provider} / ` : ""}
										{snapshot.model}
									</strong>
									<span className="detail-label">消息</span>
									<strong>{snapshot.messages.length} 条</strong>
									<span className="detail-label">会话 ID</span>
									<strong>{snapshot.id}</strong>
								</section>
								<section>
									<span className="detail-label">最近活动</span>
									{[...(snapshot.activities ?? [])]
										.reverse()
										.slice(0, 5)
										.map((activity) => (
											<div className="activity-row" key={activity.id}>
												<span className={`activity-dot ${activity.status}`} />
												<div>
													<strong>{activity.binding.name}</strong>
													<small>{activityLabels[activity.status]}</small>
												</div>
											</div>
										))}
									{!snapshot.activities?.length && <p className="context-empty">暂无活动。</p>}
								</section>
								<section>
									<BackgroundJobs key={snapshot.id} sessionId={snapshot.id} />
								</section>
							</>
						) : (
							<p className="context-empty">选择一个对话后查看。</p>
						)}
					</aside>
				)}
			</div>
			{assistantEditor && (
				<AssistantSettings
					assistant={assistantEditor === "new" ? undefined : assistantEditor}
					assistants={assistants}
					onClose={() => setAssistantEditor(undefined)}
					onSaved={(assistant) => {
						setAssistants((previous) => [...previous.filter((item) => item.id !== assistant.id), assistant]);
						setAssistantId(assistant.id);
						if (snapshot && snapshot.assistantId !== assistant.id) switchSession();
						setAssistantEditor(undefined);
					}}
					onDeleted={(id) => {
						setAssistants((previous) => previous.filter((assistant) => assistant.id !== id));
						setAssistantId(assistants.find((assistant) => assistant.id !== id)?.id ?? "");
					}}
				/>
			)}
			{showPluginSettings && <PluginSettings onClose={() => setShowPluginSettings(false)} />}
			{showModelSettings && (
				<ModelSettings
					onClose={() => setShowModelSettings(false)}
					onSaved={(selected) => {
						setSelectedModel(selected);
						setModelRevision((value) => value + 1);
					}}
				/>
			)}
			{snapshot?.interactions[0] && (
				<InteractionPrompt
					key={snapshot.interactions[0].id}
					interaction={snapshot.interactions[0]}
					error={interactionError}
					canStop={snapshot.execution.actions.cancel.available}
					onStop={() => void cancel()}
					disabled={!connected || pending || replyingInteractionId !== undefined}
					onReply={(approved, remember) => void replyToInteraction(approved, remember)}
				/>
			)}
			{tree && (
				<SessionTreeDialog
					tree={tree}
					disabled={pending}
					onClose={() => setTree(undefined)}
					onSelect={(entryId) => void selectBranch(entryId)}
				/>
			)}
		</AssistantRuntimeProvider>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(<App />);
