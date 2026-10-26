import {
	AssistantRuntimeProvider,
	ComposerPrimitive,
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
	SessionTree,
	ToolActivity,
} from "@pie/runtime/protocol";
import { applySessionEvent, messageIdentity, prependHistoryPage } from "@pie/runtime/session-events";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantSettings } from "./assistant-settings.tsx";
import { toThreadMessages, updateToolProgress } from "./messages.ts";
import { ModelSettings } from "./model-settings.tsx";
import { PluginSettings } from "./plugin-settings.tsx";
import { request } from "./request.ts";
import { SessionTreeDialog } from "./session-tree.tsx";
import "./style.css";

function Reasoning({ text }: ReasoningMessagePartProps) {
	return (
		<details className="reasoning">
			<summary>查看思考过程</summary>
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
						<pre>
							<output>{artifact}</output>
						</pre>
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
			<div className="message-avatar user-avatar">你</div>
			<div className="message-content">
				<MessagePrimitive.Parts />
			</div>
		</MessagePrimitive.Root>
	);
}

function Markdown() {
	return <MarkdownTextPrimitive />;
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="message assistant-message">
			<div className="message-avatar assistant-avatar">P</div>
			<div className="message-content">
				<MessagePrimitive.Parts components={{ Text: Markdown, Reasoning, tools: { Fallback: Tool } }} />
			</div>
		</MessagePrimitive.Root>
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function InteractionPrompt({
	interaction,
	disabled,
	onReply,
}: {
	interaction: InteractionRequest;
	disabled: boolean;
	onReply: (approved: boolean) => void;
}) {
	const display = isRecord(interaction.metadata?.display) ? interaction.metadata.display : {};
	const card = isRecord(display.previewCard) ? display.previewCard : {};
	const items = Array.isArray(card.items) ? card.items.filter(isRecord) : [];
	return (
		<div className="interaction-overlay">
			<section className="interaction-dialog" role="dialog" aria-modal="true" aria-labelledby="interaction-title">
				<div className="interaction-mark">!</div>
				<div>
					<span className="eyebrow">需要你的确认</span>
					<h2 id="interaction-title">{interaction.title}</h2>
					<p>{interaction.message}</p>
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
					<div className="interaction-actions">
						<button type="button" className="button secondary" disabled={disabled} onClick={() => onReply(false)}>
							拒绝
						</button>
						<button type="button" className="button primary" disabled={disabled} onClick={() => onReply(true)}>
							{disabled ? "处理中…" : "确认并继续"}
						</button>
					</div>
				</div>
			</section>
		</div>
	);
}

function messageText(message: SessionSnapshot["messages"][number]) {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.map((part) => (part.type === "text" ? part.text : "[图片]"))
		.join("\n")
		.trim();
}

function ForkPrompt({
	snapshot,
	disabled,
	onClose,
	onFork,
}: {
	snapshot: SessionSnapshot;
	disabled: boolean;
	onClose: () => void;
	onFork: (beforeMessageId: string) => void;
}) {
	const candidates = snapshot.messages.flatMap((message) =>
		message.role === "user"
			? [{ messageId: messageIdentity(message), text: messageText(message) || "[空用户消息]" }]
			: [],
	);
	return (
		<div className="settings-overlay">
			<section className="fork-dialog" role="dialog" aria-modal="true" aria-labelledby="fork-title">
				<div className="settings-heading">
					<div>
						<h2 id="fork-title">从历史分叉</h2>
						<p>选择一条用户消息。新对话保留它之前的历史，并把这条消息放回输入框。</p>
					</div>
					<button type="button" onClick={onClose} disabled={disabled}>
						×
					</button>
				</div>
				<div className="fork-message-list">
					{candidates.map((candidate, index) => (
						<button
							type="button"
							key={candidate.messageId}
							disabled={disabled}
							onClick={() => onFork(candidate.messageId)}
						>
							<small>用户消息 {index + 1}</small>
							<span>{candidate.text}</span>
						</button>
					))}
				</div>
			</section>
		</div>
	);
}

const activityLabels: Record<ToolActivity["status"], string> = {
	running: "处理中",
	succeeded: "已加载",
	failed: "失败",
	cancelled: "已取消",
	unknown: "状态未知",
};

function relativeTime(value: number) {
	const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000));
	if (seconds < 60) return "刚刚";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return new Date(value).toLocaleDateString("zh-CN", { month: "short", day: "numeric" });
}

function App() {
	const [providers, setProviders] = useState<ProviderCatalog>();
	const [selectedModel, setSelectedModel] = useState<ModelSelection>();
	const [snapshot, setSnapshot] = useState<SessionSnapshot>();
	const [toolProgress, setToolProgress] = useState<ReadonlyMap<string, string>>(new Map());
	const [assistants, setAssistants] = useState<Assistant[]>([]);
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [assistantId, setAssistantId] = useState("");
	const [title, setTitle] = useState("");
	const [query, setQuery] = useState("");
	const [coreReady, setCoreReady] = useState(false);
	const [connected, setConnected] = useState(false);
	const [loadingHistory, setLoadingHistory] = useState(false);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [showSidebar, setShowSidebar] = useState(false);
	const [showContext, setShowContext] = useState(() => window.matchMedia("(min-width: 941px)").matches);
	const [showModelSettings, setShowModelSettings] = useState(false);
	const [showPluginSettings, setShowPluginSettings] = useState(false);
	const [showFork, setShowFork] = useState(false);
	const [tree, setTree] = useState<SessionTree>();
	const [assistantEditor, setAssistantEditor] = useState<Assistant | "new">();
	const [replyingInteractionId, setReplyingInteractionId] = useState<string>();
	const draftRef = useRef(new Map<string, string>());
	const sessionRef = useRef<SessionSnapshot | undefined>(undefined);
	const busy = pending || snapshot?.turn?.status === "running";
	const interrupted = snapshot?.turn?.status === "interrupted";

	const accept = useCallback((next: SessionSnapshot) => {
		if (sessionRef.current?.id !== next.id) return;
		const previous = sessionRef.current;
		if (previous.instanceId === next.instanceId && previous.revision > next.revision) return;
		sessionRef.current = next;
		setSnapshot(next);
	}, []);

	const refreshSessions = useCallback(async () => {
		const result = await request<{ sessions: SessionSummary[] }>("/sessions");
		const realSessions = result.sessions
			.filter((session) => session.mode === "real")
			.sort((left, right) => right.updatedAt - left.updatedAt);
		setSessions(realSessions);
		return realSessions;
	}, []);

	const activate = useCallback((next?: SessionSnapshot) => {
		sessionRef.current = next;
		setSnapshot(next);
		setToolProgress(new Map());
		setTitle(next?.title ?? "");
		setConnected(false);
		if (next) {
			setAssistantId(next.assistantId);
			localStorage.setItem("pie.web.session", next.id);
		} else {
			localStorage.removeItem("pie.web.session");
		}
	}, []);

	const initialize = useCallback(async () => {
		setPending(true);
		setError("");
		setCoreReady(false);
		try {
			await request<ServerInfo>("/health");
			setCoreReady(true);
			const [providerCatalog, assistantCatalog, allSessions] = await Promise.all([
				request<ProviderCatalog>("/providers"),
				request<{ assistants: Assistant[] }>("/assistants"),
				refreshSessions(),
			]);
			setProviders(providerCatalog);
			setSelectedModel(providerCatalog.selected);
			setAssistants(assistantCatalog.assistants);
			const defaultAssistantId = assistantCatalog.assistants[0]?.id ?? "";
			setAssistantId(defaultAssistantId);
			const saved = localStorage.getItem("pie.web.session");
			const existing = allSessions.find((session) => session.id === saved) ?? allSessions[0];
			activate(existing ? await request<SessionSnapshot>(`/sessions/${existing.id}?limit=50`) : undefined);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setPending(false);
		}
	}, [activate, refreshSessions]);

	useEffect(() => {
		void initialize();
	}, [initialize]);
	useEffect(() => {
		const timer = setInterval(() => void refreshSessions().catch(() => {}), 5000);
		return () => clearInterval(timer);
	}, [refreshSessions]);
	useEffect(() => {
		const sessionId = snapshot?.id;
		if (!sessionId) return;
		let source: EventSource;
		function connect() {
			setConnected(false);
			source = new EventSource(`/api/sessions/${sessionId}/events`);
			source.onmessage = (message) => {
				const packet: SessionEvent = JSON.parse(message.data);
				if (sessionRef.current?.id !== packet.sessionId) return;
				const next = applySessionEvent(sessionRef.current, packet);
				if (!next) {
					source.close();
					connect();
					return;
				}
				setConnected(true);
				accept(next);
				setToolProgress((current) => updateToolProgress(current, packet));
				if (packet.type === "turn.settled") void refreshSessions().catch(() => {});
			};
			source.onerror = () => setConnected(false);
		}
		connect();
		return () => source.close();
	}, [accept, refreshSessions, snapshot?.id]);

	async function loadEarlierHistory() {
		const current = sessionRef.current;
		const cursor = current?.history?.nextBeforeSeq;
		if (!current || cursor == null || loadingHistory) return;
		setLoadingHistory(true);
		try {
			const page = await request<SessionHistoryPage>(
				`/sessions/${current.id}/history?limit=50&beforeSeq=${cursor}&leafId=${encodeURIComponent(current.history?.leafId ?? "null")}`,
			);
			const latest = sessionRef.current;
			if (latest?.id === current.id) accept(prependHistoryPage(latest, page, cursor));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setLoadingHistory(false);
		}
	}

	async function operate(action: () => Promise<void>) {
		if (pending) return;
		setPending(true);
		setError("");
		try {
			await action();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setPending(false);
		}
	}

	function switchSession(next?: SessionSnapshot) {
		if (sessionRef.current) draftRef.current.set(sessionRef.current.id, runtime.thread.composer.getState().text);
		runtime.thread.composer.setText(next ? (draftRef.current.get(next.id) ?? "") : "");
		setShowFork(false);
		setTree(undefined);
		activate(next);
		setShowSidebar(false);
	}

	async function send(text: string) {
		const current = sessionRef.current;
		if (
			!current ||
			!connected ||
			pending ||
			current.turn?.status === "running" ||
			current.turn?.status === "interrupted"
		)
			return;
		if (text.trim() === "/tree") return openTree();
		setPending(true);
		setError("");
		try {
			await request(`/sessions/${current.id}/turns`, "POST", { text });
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
			throw reason;
		} finally {
			setPending(false);
		}
	}

	async function cancel() {
		const current = sessionRef.current;
		if (!current?.turn) return;
		try {
			await request(`/sessions/${current.id}/cancel`, "POST", { turnId: current.turn.id });
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		}
	}

	async function replyToInteraction(approved: boolean) {
		const current = sessionRef.current;
		const interaction = current?.interactions[0];
		if (!current || !interaction || replyingInteractionId) return;
		setReplyingInteractionId(interaction.id);
		try {
			await request(`/sessions/${current.id}/interactions/${interaction.id}`, "POST", { approved });
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setReplyingInteractionId(undefined);
		}
	}

	async function newSession() {
		if (pending || !assistantId || !selectedModel) return;
		setPending(true);
		setError("");
		try {
			const next = await request<SessionSnapshot>("/sessions", "POST", {
				assistantId,
				mode: "real",
				model: selectedModel,
			});
			switchSession(next);
			await refreshSessions();
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			setPending(false);
		}
	}

	async function forkSession(beforeMessageId: string) {
		const current = sessionRef.current;
		if (!current || current.turn?.status === "running") return;
		await operate(async () => {
			const result = await request<SessionForkResult>(`/sessions/${current.id}/fork`, "POST", { beforeMessageId });
			draftRef.current.set(result.session.id, result.selectedText);
			switchSession(result.session);
			await refreshSessions();
		});
	}

	async function openTree() {
		const current = sessionRef.current;
		if (!current || busy) return;
		await operate(async () => setTree(await request<SessionTree>(`/sessions/${current.id}/tree`)));
	}

	async function navigateTree(entryId: string) {
		const current = sessionRef.current;
		if (!current || busy) return;
		await operate(async () => {
			const result = await request<SessionForkResult>(`/sessions/${current.id}/tree`, "POST", { entryId });
			accept(result.session);
			setToolProgress(new Map());
			if (tree?.entries.find((entry) => entry.id === entryId)?.role === "user") {
				runtime.thread.composer.setText(result.selectedText);
				draftRef.current.set(current.id, result.selectedText);
			}
			setTree(undefined);
			await refreshSessions();
		});
	}

	const messages = useMemo(() => toThreadMessages(snapshot, toolProgress), [snapshot, toolProgress]);
	const runtime = useExternalStoreRuntime({
		messages,
		convertMessage: (message: ThreadMessageLike) => message,
		isRunning: busy,
		isDisabled: !connected || pending || interrupted,
		onNew: async (message) => {
			await send(message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"));
		},
		onCancel: cancel,
	});
	const currentAssistant = assistants.find((assistant) => assistant.id === assistantId);
	const visibleSessions = sessions.filter(
		(session) =>
			session.assistantId === assistantId && session.title.toLowerCase().includes(query.trim().toLowerCase()),
	);
	const connectionLabel = !coreReady
		? "Core 离线"
		: snapshot?.turn?.status === "running"
			? "正在处理"
			: snapshot && !connected
				? "正在重连"
				: "Core 已连接";

	return (
		<AssistantRuntimeProvider runtime={runtime}>
			<div className={`app-shell ${showSidebar ? "show-sidebar" : ""} ${showContext ? "show-context" : ""}`}>
				<aside className="sidebar">
					<div className="brand">
						<span className="brand-mark">P</span>
						<div>
							<strong>Pie</strong>
							<small>Agent workspace</small>
						</div>
						<button
							type="button"
							className="icon-button sidebar-close mobile-only"
							aria-label="关闭导航"
							onClick={() => setShowSidebar(false)}
						>
							×
						</button>
					</div>
					<section className="assistant-picker">
						<label htmlFor="assistant-select">当前助手</label>
						<div className="select-row">
							<select
								id="assistant-select"
								value={assistantId}
								disabled={pending}
								onChange={(event) => {
									const id = event.target.value;
									void operate(async () => {
										const latest = (await refreshSessions()).find((session) => session.assistantId === id);
										switchSession(
											latest ? await request<SessionSnapshot>(`/sessions/${latest.id}?limit=50`) : undefined,
										);
										setAssistantId(id);
									});
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
								className="icon-button"
								aria-label="编辑助手"
								disabled={!currentAssistant}
								onClick={() => setAssistantEditor(currentAssistant)}
							>
								•••
							</button>
						</div>
						<label htmlFor="model-select">新会话模型</label>
						<select
							id="model-select"
							value={selectedModel ? JSON.stringify(selectedModel) : ""}
							disabled={pending || !selectedModel}
							onChange={(event) => setSelectedModel(JSON.parse(event.target.value) as ModelSelection)}
						>
							{!selectedModel && <option value="">请先配置模型</option>}
							{providers?.providers.flatMap((provider) =>
								provider.models.map((model) => (
									<option
										key={`${provider.id}:${model.id}`}
										value={JSON.stringify({ provider: provider.id, id: model.id })}
									>
										{provider.name} / {model.id}
									</option>
								)),
							)}
						</select>
						<button
							type="button"
							className="button primary new-session"
							disabled={pending || !assistantId || !selectedModel}
							onClick={() => void newSession()}
						>
							<span>＋</span> 新建对话
						</button>
					</section>
					<div className="session-search">
						<span>⌕</span>
						<input
							value={query}
							aria-label="搜索对话"
							placeholder="搜索对话"
							onChange={(event) => setQuery(event.target.value)}
						/>
					</div>
					<nav className="session-list" aria-label="对话列表">
						<div className="section-label">最近对话</div>
						{visibleSessions.map((session) => (
							<button
								type="button"
								key={session.id}
								className={session.id === snapshot?.id ? "active" : ""}
								disabled={pending}
								onClick={() =>
									void operate(async () =>
										switchSession(await request<SessionSnapshot>(`/sessions/${session.id}?limit=50`)),
									)
								}
							>
								<span>{session.title}</span>
								<small>
									{session.turn?.status === "running" ? "正在处理" : relativeTime(session.updatedAt)}
								</small>
							</button>
						))}
						{visibleSessions.length === 0 && <p className="empty-list">没有找到对话</p>}
					</nav>
					<div className="sidebar-footer">
						<button type="button" onClick={() => setAssistantEditor("new")}>
							＋ 新建助手
						</button>
						<button type="button" onClick={() => setShowPluginSettings(true)}>
							插件
						</button>
						<button type="button" onClick={() => setShowModelSettings(true)}>
							模型设置
						</button>
					</div>
				</aside>

				<main className="workspace">
					<header className="topbar">
						<button
							type="button"
							className="icon-button mobile-only"
							onClick={() => setShowSidebar(!showSidebar)}
						>
							☰
						</button>
						<div className="conversation-title">
							<strong>{snapshot?.title ?? currentAssistant?.name ?? "Pie"}</strong>
							<span>
								<i className={coreReady && (!snapshot || connected) ? "online" : ""} /> {connectionLabel}
							</span>
						</div>
						<div className="topbar-actions">
							<span className="model-pill">{snapshot?.model ?? selectedModel?.id ?? "未配置模型"}</span>
							<button type="button" className="button secondary" onClick={() => setShowContext(!showContext)}>
								{showContext ? "收起详情" : "会话详情"}
							</button>
						</div>
					</header>
					{error && (
						<div className="banner error" role="alert">
							<span>{error}</span>
							<button type="button" onClick={() => void initialize()} disabled={pending}>
								重新连接
							</button>
						</div>
					)}
					<ThreadPrimitive.Root key={snapshot?.id ?? "empty"} className="thread">
						<ThreadPrimitive.Viewport className="viewport">
							{messages.length === 0 && (
								<section className="welcome">
									<div className="welcome-mark">P</div>
									<span className="eyebrow">PIE AGENT CORE</span>
									<h1>
										{snapshot
											? `和 ${snapshot.assistant?.name ?? snapshot.assistantId} 开始工作`
											: "创建一个对话，开始工作"}
									</h1>
									<p>
										{selectedModel
											? "你的助手可以使用已配置的模型、工具和 Skill 完成任务。"
											: "先配置模型，再创建第一个真实对话。"}
									</p>
									{snapshot && (
										<div className="suggestions">
											{[
												["梳理思路", "帮我把现在的想法整理成可执行计划"],
												["分析项目", "分析当前项目，指出最值得先做的三件事"],
												["开始任务", "先问我必要信息，然后开始完成任务"],
											].map(([label, prompt]) => (
												<button
													key={label}
													type="button"
													disabled={!connected || busy}
													onClick={() => void send(prompt).catch(() => {})}
												>
													<strong>{label}</strong>
													<span>{prompt}</span>
												</button>
											))}
										</div>
									)}
									{!snapshot && selectedModel && (
										<button
											type="button"
											className="button primary welcome-action"
											onClick={() => void newSession()}
										>
											创建新对话
										</button>
									)}
									{!selectedModel && (
										<button
											type="button"
											className="button primary welcome-action"
											onClick={() => setShowModelSettings(true)}
										>
											配置模型
										</button>
									)}
								</section>
							)}
							{snapshot?.history?.nextBeforeSeq != null && (
								<button
									type="button"
									className="button secondary"
									disabled={loadingHistory}
									onClick={() => void loadEarlierHistory()}
								>
									{loadingHistory ? "正在加载…" : "加载更早消息"}
								</button>
							)}
							<div className="transcript">
								<ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
							</div>
						</ThreadPrimitive.Viewport>
						{snapshot && (
							<div className="composer-area">
								{snapshot.turn && snapshot.turn.status !== "running" && (
									<output className={`turn-status ${snapshot.turn.status}`}>
										{snapshot.turn.status === "failed"
											? snapshot.turn.error
											: snapshot.turn.status === "cancelled"
												? "本次执行已停止"
												: interrupted
													? "执行已中断，可从已保存的消息边界继续"
													: "任务已完成"}
									</output>
								)}
								{interrupted && snapshot.turn && (
									<div className="interaction-actions">
										<button
											type="button"
											className="button secondary"
											disabled={!connected || pending}
											onClick={() => void cancel()}
										>
											停止本次执行
										</button>
										<button
											type="button"
											className="button primary"
											disabled={!connected || pending}
											onClick={() =>
												void operate(async () => {
													await request(`/sessions/${snapshot.id}/resume`, "POST", {
														turnId: snapshot.turn?.id,
													});
												})
											}
										>
											继续本次执行
										</button>
									</div>
								)}
								<ComposerPrimitive.Root className="composer">
									<ComposerPrimitive.Input
										aria-label="发送消息"
										placeholder={connected ? "告诉 Pie 你想完成什么…" : "正在连接 Core…"}
										maxLength={16000}
										disabled={!connected || pending || interrupted}
									/>
									<div className="composer-footer">
										<span>Enter 发送 · Shift + Enter 换行</span>
										{busy ? (
											<button type="button" className="send stop" onClick={() => void cancel()}>
												■
											</button>
										) : (
											<ComposerPrimitive.Send className="send" aria-label="发送">
												↑
											</ComposerPrimitive.Send>
										)}
									</div>
								</ComposerPrimitive.Root>
								<p className="disclaimer">模型可能出错，请检查重要信息。</p>
							</div>
						)}
					</ThreadPrimitive.Root>
				</main>

				{showContext && (
					<aside className="context-panel">
						<div className="context-heading">
							<div>
								<span className="eyebrow">SESSION CONTEXT</span>
								<h2>会话详情</h2>
							</div>
							<button type="button" className="icon-button" onClick={() => setShowContext(false)}>
								×
							</button>
						</div>
						{snapshot ? (
							<>
								<section className="context-section">
									<span className="section-label">会话</span>
									<form
										className="title-form"
										onSubmit={(event) => {
											event.preventDefault();
											void operate(async () => {
												accept(
													await request<SessionSnapshot>(`/sessions/${snapshot.id}`, "PATCH", { title }),
												);
												await refreshSessions();
											});
										}}
									>
										<input
											value={title}
											maxLength={100}
											required
											disabled={busy}
											onChange={(event) => setTitle(event.target.value)}
										/>
										<button type="submit" disabled={busy || title === snapshot.title}>
											保存
										</button>
									</form>
									<dl className="facts">
										<div>
											<dt>助手</dt>
											<dd>{snapshot.assistant?.name ?? snapshot.assistantId}</dd>
										</div>
										<div>
											<dt>模型</dt>
											<dd>
												{snapshot.provider ? `${snapshot.provider} / ` : ""}
												{snapshot.model}
											</dd>
										</div>
										<div>
											<dt>工具</dt>
											<dd>{snapshot.runtime?.toolIds.length ?? 0} 个</dd>
										</div>
										<div>
											<dt>上下文</dt>
											<dd>
												{snapshot.compaction
													? `已压缩 ${snapshot.compaction.generation} 次，约 ${snapshot.compaction.estimatedTokensAfter.toLocaleString()} tokens`
													: `${snapshot.messages.length} 条消息，尚未压缩`}
											</dd>
										</div>
									</dl>
									<div className="session-actions">
										<button type="button" disabled={busy} onClick={() => void openTree()}>
											会话树
										</button>
										<button
											type="button"
											disabled={busy || !snapshot.messages.some((message) => message.role === "user")}
											onClick={() => setShowFork(true)}
										>
											从历史分叉
										</button>
									</div>
								</section>
								<section className="context-section">
									<span className="section-label">可用 Skill</span>
									{snapshot.runtime?.skills.map((skill) => (
										<div className="skill-row" key={skill.id}>
											<div>
												<strong>{skill.name}</strong>
												<small>{skill.source?.pluginName ?? "本地 Skill"}</small>
											</div>
											<button
												type="button"
												disabled={busy || !connected}
												onClick={() => void send(`加载技能 ${skill.id}`).catch(() => {})}
											>
												加载
											</button>
										</div>
									))}
									{!snapshot.runtime?.skills.length && (
										<p className="context-empty">当前助手没有挂载 Skill。</p>
									)}
								</section>
								<section className="context-section">
									<span className="section-label">最近活动</span>
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
									{!snapshot.activities?.length && <p className="context-empty">暂无 Skill 活动。</p>}
								</section>
								<div className="danger-zone">
									<button
										type="button"
										disabled={busy}
										onClick={() =>
											void operate(async () => {
												if (!window.confirm(`删除对话“${snapshot.title}”及其历史？`)) return;
												await request(`/sessions/${snapshot.id}`, "DELETE");
												draftRef.current.delete(snapshot.id);
												switchSession();
												const remaining = (await refreshSessions()).find(
													(session) => session.assistantId === assistantId,
												);
												if (remaining)
													switchSession(
														await request<SessionSnapshot>(`/sessions/${remaining.id}?limit=50`),
													);
											})
										}
									>
										删除当前对话
									</button>
								</div>
							</>
						) : (
							<p className="context-empty">选择一个对话后查看会话信息。</p>
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
						if (assistantEditor === "new") {
							switchSession();
							setAssistantId(assistant.id);
						}
					}}
				/>
			)}
			{showPluginSettings && <PluginSettings onClose={() => setShowPluginSettings(false)} />}
			{showModelSettings && (
				<ModelSettings
					onClose={() => setShowModelSettings(false)}
					onSaved={(selected) => {
						setSelectedModel(selected);
						void request<ProviderCatalog>("/providers")
							.then(setProviders)
							.catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
					}}
				/>
			)}
			{tree && (
				<SessionTreeDialog
					tree={tree}
					disabled={busy}
					onClose={() => setTree(undefined)}
					onSelect={(entryId) => void navigateTree(entryId)}
				/>
			)}
			{showFork && snapshot && (
				<ForkPrompt
					snapshot={snapshot}
					disabled={pending}
					onClose={() => setShowFork(false)}
					onFork={(beforeMessageId) => void forkSession(beforeMessageId)}
				/>
			)}
			{snapshot?.interactions[0] && (
				<InteractionPrompt
					interaction={snapshot.interactions[0]}
					disabled={replyingInteractionId !== undefined}
					onReply={(approved) => void replyToInteraction(approved)}
				/>
			)}
		</AssistantRuntimeProvider>
	);
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing root element");
createRoot(root).render(<App />);
