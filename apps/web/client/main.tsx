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
	SessionSnapshot,
	SessionSummary,
	ToolActivity,
} from "@pie/runtime/protocol";
import { applySessionEvent } from "@pie/runtime/session-events";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { AssistantSettings } from "./assistant-settings.tsx";
import { toThreadMessages, updateToolProgress } from "./messages.ts";
import { ModelSettings } from "./model-settings.tsx";
import { PluginSettings } from "./plugin-settings.tsx";
import { request } from "./request.ts";
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
		<div className="modal-backdrop">
			<section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="interaction-title">
				<div className="dialog-mark">!</div>
				<div>
					<span className="dialog-kicker">需要你的确认</span>
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
					<div className="dialog-actions">
						<button type="button" disabled={disabled} onClick={() => onReply(false)}>
							拒绝
						</button>
						<button type="button" className="confirm-button" disabled={disabled} onClick={() => onReply(true)}>
							{disabled ? "处理中…" : "确认并继续"}
						</button>
					</div>
				</div>
			</section>
		</div>
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
	const sessionRef = useRef<SessionSnapshot | undefined>(undefined);
	const busy = pending || snapshot?.turn?.status === "running";
	const interrupted = snapshot?.turn?.status === "interrupted";

	const accept = useCallback((next: SessionSnapshot) => {
		const previous = sessionRef.current;
		if (previous?.id !== next.id) return;
		if (previous.instanceId === next.instanceId && previous.revision > next.revision) return;
		sessionRef.current = next;
		setSnapshot(next);
	}, []);

	const refreshSessions = useCallback(async () => {
		const result = await request<{ sessions: SessionSummary[] }>("/sessions");
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
		if (next) {
			setAssistantId(next.assistantId);
			localStorage.setItem("pie.web.session", next.id);
		} else localStorage.removeItem("pie.web.session");
	}, []);

	const initialize = useCallback(async () => {
		setPending(true);
		setError("");
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
			const savedId = localStorage.getItem("pie.web.session");
			const existing = allSessions.find((session) => session.id === savedId) ?? allSessions[0];
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
		let source: EventSource | undefined;
		let closed = false;
		const connect = () => {
			if (closed) return;
			setConnected(false);
			source = new EventSource(`/api/sessions/${sessionId}/events`);
			source.onmessage = (message) => {
				const packet = JSON.parse(message.data) as SessionEvent;
				if (sessionRef.current?.id !== packet.sessionId) return;
				const next = applySessionEvent(sessionRef.current, packet);
				if (!next) {
					source?.close();
					void request<SessionSnapshot>(`/sessions/${sessionId}?limit=50`)
						.then(activate)
						.catch(() => {});
					return;
				}
				setConnected(true);
				accept(next);
				setToolProgress((current) => updateToolProgress(current, packet));
				if (packet.type === "turn.settled") void refreshSessions().catch(() => {});
			};
			source.onerror = () => setConnected(false);
		};
		connect();
		return () => {
			closed = true;
			source?.close();
		};
	}, [accept, activate, refreshSessions, snapshot?.id]);

	function switchSession(next?: SessionSnapshot) {
		activate(next);
		setShowSidebar(false);
		setShowDetails(false);
	}

	async function send(text: string) {
		const current = sessionRef.current;
		if (!current || !connected || pending || busy || interrupted || !text.trim()) return;
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

	async function resume() {
		const current = sessionRef.current;
		if (!current?.turn) return;
		try {
			await request(`/sessions/${current.id}/resume`, "POST", { turnId: current.turn.id });
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
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

	const messages = useMemo(() => toThreadMessages(snapshot, toolProgress), [snapshot, toolProgress]);
	const runtime = useExternalStoreRuntime({
		messages,
		convertMessage: (message: ThreadMessageLike) => message,
		isRunning: Boolean(busy),
		isDisabled: !connected || pending || Boolean(interrupted),
		onNew: async (message) =>
			send(message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n")),
		onCancel: cancel,
	});
	const currentAssistant = assistants.find((assistant) => assistant.id === assistantId);
	const visibleSessions = sessions.filter((session) =>
		session.title.toLowerCase().includes(query.trim().toLowerCase()),
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
				<aside className="sidebar">
					<header className="sidebar-header">
						<button type="button" className="brand-button" aria-label="Pie 首页" onClick={() => switchSession()}>
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
								disabled={pending || !selectedModel}
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
								setAssistantId(id);
								const latest = sessions.find((session) => session.assistantId === id);
								if (latest)
									void request<SessionSnapshot>(`/sessions/${latest.id}?limit=50`)
										.then(switchSession)
										.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
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
						<span>新建分组</span>
						<button type="button" className="plain-icon" aria-label="添加分组">
							＋
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
								onClick={() =>
									void request<SessionSnapshot>(`/sessions/${session.id}?limit=50`)
										.then(switchSession)
										.catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)))
								}
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
						{visibleSessions.length === 0 && <p className="empty-list">还没有对话</p>}
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
				<main className="workspace">
					<header className="chat-header">
						<button
							type="button"
							className="circle-button mobile-only"
							aria-label="打开导航"
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
							<span className="model-pill">{snapshot?.model ?? selectedModel?.id ?? "未配置模型"}</span>
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
						</div>
					)}
					<ThreadPrimitive.Root key={snapshot?.id ?? "empty"} className="thread">
						<ThreadPrimitive.Viewport className="viewport">
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
													onClick={() => void send(prompt).catch(() => {})}
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
								</section>
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
													? "执行已中断，可继续本次对话"
													: "任务已完成"}
									</output>
								)}
								{interrupted && (
									<div className="resume-actions">
										<button type="button" disabled={!connected || pending} onClick={() => void cancel()}>
											停止
										</button>
										<button
											type="button"
											className="confirm-button"
											disabled={!connected || pending}
											onClick={() => void resume()}
										>
											继续
										</button>
									</div>
								)}
								<ComposerPrimitive.Root className="composer">
									<button type="button" className="composer-plus" aria-label="添加内容" disabled>
										＋
									</button>
									<ComposerPrimitive.Input
										aria-label="发送消息"
										placeholder={connected ? "给 Pie 发消息" : "正在连接 Core…"}
										maxLength={16000}
										disabled={!connected || pending || Boolean(interrupted)}
									/>
									<div className="composer-footer">
										<span>Enter 发送 · Shift + Enter 换行</span>
										{busy ? (
											<button
												type="button"
												className="send stop"
												aria-label="停止执行"
												onClick={() => void cancel()}
											>
												■
											</button>
										) : (
											<ComposerPrimitive.Send className="send" aria-label="发送">
												↑
											</ComposerPrimitive.Send>
										)}
									</div>
								</ComposerPrimitive.Root>
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
						setAssistantEditor(undefined);
					}}
				/>
			)}
			{showPluginSettings && <PluginSettings onClose={() => setShowPluginSettings(false)} />}
			{showModelSettings && (
				<ModelSettings
					onClose={() => setShowModelSettings(false)}
					onSaved={(selected) => setSelectedModel(selected)}
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
