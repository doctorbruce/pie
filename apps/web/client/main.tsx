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
import remarkGfm from "remark-gfm";
import { AssistantSettings } from "./assistant-settings.tsx";
import { Composer, clearDraft, type Draft, readDraft } from "./composer.tsx";
import { BotMark, Icon } from "./icons.tsx";
import { toThreadMessages, updateToolProgress } from "./messages.ts";
import { ModelSettings } from "./model-settings.tsx";
import { PluginSettings } from "./plugin-settings.tsx";
import { request } from "./request.ts";
import { type SessionAction, SessionActionDialog, SessionActions } from "./session-actions.tsx";
import { connectSession } from "./session-connection.ts";
import { BackgroundJobs } from "./session-jobs.tsx";
import { SessionModelSelect } from "./session-model.tsx";
import { createSessionTitles } from "./session-title.ts";
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
				<Icon name="chevron" className="chevron" />
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
				<div className="message-body">
					<MessagePrimitive.Parts />
				</div>
				<ActionBarPrimitive.Root className="message-actions">
					<ActionBarPrimitive.Copy aria-label="复制消息" title="复制消息">
						<span className="copy-label">
							<Icon name="copy" />
						</span>
						<span className="copied-label">
							<Icon name="check" /> 已复制
						</span>
					</ActionBarPrimitive.Copy>
				</ActionBarPrimitive.Root>
			</div>
		</MessagePrimitive.Root>
	);
}

function AssistantMessage() {
	return (
		<MessagePrimitive.Root className="message assistant-message">
			<div className="assistant-badge">
				<BotMark />
			</div>
			<div className="message-content">
				<div className="message-body">
					<MessagePrimitive.Parts components={{ Text: Markdown, Reasoning, tools: { Fallback: Tool } }} />
				</div>
				<MessagePrimitive.Error>
					<p className="message-error">回复未完成，请查看下方状态并重试。</p>
				</MessagePrimitive.Error>
				<ActionBarPrimitive.Root className="message-actions">
					<ActionBarPrimitive.Copy aria-label="复制回复" title="复制回复">
						<span className="copy-label">
							<Icon name="copy" />
						</span>
						<span className="copied-label">
							<Icon name="check" /> 已复制
						</span>
					</ActionBarPrimitive.Copy>
				</ActionBarPrimitive.Root>
			</div>
		</MessagePrimitive.Root>
	);
}

function Markdown() {
	return <MarkdownTextPrimitive remarkPlugins={[remarkGfm]} />;
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
				{typeof interaction.metadata?.workdir === "string" && interaction.metadata.workdir && (
					<p className="interaction-workdir">
						工作目录：<code>{interaction.metadata.workdir}</code>
					</p>
				)}
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
					<div className="interaction-permission">
						<label className="settings-checkbox">
							<input
								type="checkbox"
								checked={remember}
								onChange={(event) => setRemember(event.target.checked)}
								disabled={disabled}
							/>
							在本会话内自动批准相同范围的后续操作
						</label>
						<details>
							<summary>查看授权范围</summary>
							<pre>{JSON.stringify(interaction.remember, null, 2)}</pre>
						</details>
					</div>
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
	const [sessionAction, setSessionAction] = useState<{ action: "rename" | "delete"; session: SessionSummary }>();
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
	const detailsPanel = useRef<HTMLDivElement>(null);
	const detailsReturnFocus = useRef<HTMLElement | null>(null);
	const selection = useRef(0);
	const operation = useRef(false);
	const initialized = useRef(false);
	const initializing = useRef(false);
	const turnSender = useRef(createTurnSender());
	const sessionTitles = useRef(createSessionTitles());
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
		if (!snapshot || pending) return;
		void sessionTitles.current
			.apply(snapshot)
			.then((next) => {
				if (!next) return;
				accept(next);
				return refreshSessions();
			})
			.catch(() => {});
	}, [accept, pending, refreshSessions, snapshot]);
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
		if (!showDetails) return;
		detailsPanel.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
		return () => {
			if (detailsReturnFocus.current?.isConnected) detailsReturnFocus.current.focus({ preventScroll: true });
		};
	}, [showDetails]);
	useEffect(() => {
		const handleEscape = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !document.querySelector("dialog[open], [popover]:popover-open")) {
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
	function openDetails() {
		detailsReturnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
		setShowSidebar(false);
		setShowDetails(true);
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
		let current = sessionRef.current;
		const action = current?.execution.actions[busy ? "steer" : "submit"];
		if (
			operation.current ||
			(current ? !connected || !action?.available : !coreReady || !assistantId) ||
			(!draft.text.trim() && !draft.images.length)
		)
			return false;
		if (!current && !selectedModel) {
			setShowModelSettings(true);
			return false;
		}
		const creating = !current;
		operation.current = true;
		setPending(true);
		setError("");
		try {
			if (!current) {
				current = await request<SessionSnapshot>("/sessions", "POST", {
					assistantId,
					mode: "real",
					model: selectedModel,
				});
				store(`pie.draft.${current.id}`, draft.text);
				clearDraft("new");
				switchSession(current);
				setInitialDraft(draft);
				void refreshSessions().catch(() => {});
			}
			const reconciled = await turnSender.current.send(current, draft);
			if (reconciled) accept(reconciled);
			if (!busy) sessionTitles.current.remember(current, draft.text);
			if (creating) {
				store(`pie.draft.${current.id}`, "");
				setInitialDraft({ text: "", images: [] });
				setDraftVersion((value) => value + 1);
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
			if (!action && method === "PATCH" && isRecord(body) && typeof body.title === "string")
				await sessionTitles.current.clear(current.id);
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
	async function performSessionAction(action: SessionAction, target: SessionSummary, title?: string) {
		if (operation.current) throw new Error("请等待当前操作完成");
		operation.current = true;
		setPending(true);
		try {
			if (action === "delete") {
				await sessionTitles.current.clear(target.id);
				await request(`/sessions/${target.id}`, "DELETE");
				clearDraft(target.id);
				setSessions((previous) => previous.filter((session) => session.id !== target.id));
				if (sessionRef.current?.id === target.id) switchSession();
				setNotice(`已删除「${target.title}」`);
			} else {
				if (action === "rename") await sessionTitles.current.clear(target.id);
				const next = await request<SessionSnapshot>(
					`/sessions/${target.id}${action === "archive" ? "/archive" : ""}`,
					action === "archive" ? "POST" : "PATCH",
					action === "archive" ? { archived: !target.archived } : { title },
				);
				accept(next);
				setSessions((previous) =>
					previous
						.map((session) =>
							session.id === next.id
								? { ...session, title: next.title, archived: next.archived, updatedAt: next.updatedAt }
								: session,
						)
						.sort((left, right) => right.updatedAt - left.updatedAt),
				);
				setNotice(
					action === "rename"
						? "会话名称已更新"
						: next.archived
							? `已归档「${next.title}」，可在归档列表中恢复`
							: `已恢复「${next.title}」`,
				);
			}
			void refreshSessions().catch(() => {});
		} finally {
			operation.current = false;
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
	const lastText = snapshot?.messages
		.filter((message) => message.role === "user" || message.role === "assistant")
		.slice()
		.reverse()
		.flatMap((message) =>
			typeof message.content === "string"
				? [message.content]
				: message.content.filter((part) => part.type === "text").map((part) => part.text),
		)
		.find((text) => text.trim());
	const connectionLabel = !coreReady ? "连接已断开" : busy ? "正在处理" : snapshot && !connected ? "正在重连" : "在线";

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
							<span className="brand-mark">
								<BotMark />
							</span>
							<strong>Pie</strong>
						</button>
						<div className="sidebar-actions">
							<button
								type="button"
								className="circle-button"
								aria-label="搜索会话"
								onClick={() => document.getElementById("session-search")?.focus()}
							>
								<Icon name="search" />
							</button>
							<button
								type="button"
								className="circle-button add-button"
								aria-label="新建对话"
								disabled={pending || !coreReady}
								onClick={() => switchSession()}
							>
								<Icon name="plus" />
							</button>
						</div>
					</header>
					<div className="sidebar-profile">
						<button
							type="button"
							className="profile-avatar"
							aria-label="编辑当前助手"
							disabled={!currentAssistant}
							onClick={() => setAssistantEditor(currentAssistant)}
						>
							<BotMark />
						</button>
						<div className="assistant-strip">
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
								<Icon name="chevron" />
							</button>
						</div>
					</div>
					<div className="group-heading">
						<span>
							{archived ? "已归档" : "对话"}
							<span className="session-count">{visibleSessions.length}</span>
						</span>
						<button
							type="button"
							className="plain-icon"
							aria-label={archived ? "返回最近会话" : "查看归档"}
							title={archived ? "返回最近会话" : "查看归档"}
							onClick={() => setArchived(!archived)}
						>
							<Icon name={archived ? "chat" : "archive"} />
						</button>
					</div>
					<div className="session-search">
						<Icon name="search" />
						<input
							id="session-search"
							value={query}
							aria-label="搜索对话"
							placeholder="搜索对话"
							onChange={(event) => setQuery(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Escape" && query) {
									event.stopPropagation();
									setQuery("");
								}
							}}
						/>
						{query && (
							<button
								type="button"
								className="search-clear"
								aria-label="清除搜索"
								title="清除搜索"
								onClick={() => {
									setQuery("");
									document.getElementById("session-search")?.focus();
								}}
							>
								<Icon name="close" />
							</button>
						)}
					</div>
					<nav className="session-list" aria-label="对话列表">
						{visibleSessions.map((session) => (
							<div className="session-row-wrap" key={session.id}>
								<button
									type="button"
									className={`session-row ${session.id === snapshot?.id ? "active" : ""}`}
									disabled={pending}
									onClick={() => void openSession(session.id)}
									aria-current={session.id === snapshot?.id ? "page" : undefined}
								>
									<span
										className={`session-icon avatar-tone-${
											Math.max(
												0,
												assistants.findIndex((assistant) => assistant.id === session.assistantId),
											) % 5
										}`}
									>
										<BotMark />
									</span>
									<span className="session-copy">
										<span className="session-meta">
											<strong title={session.title}>{session.title}</strong>
											<time
												dateTime={new Date(session.updatedAt).toISOString()}
												title={new Date(session.updatedAt).toLocaleString("zh-CN")}
											>
												{relativeTime(session.updatedAt)}
											</time>
										</span>
										<small className="session-preview">
											{session.turn?.status === "running"
												? "正在回复…"
												: session.id === snapshot?.id && lastText
													? lastText
													: (assistants.find((assistant) => assistant.id === session.assistantId)?.name ??
														"开始聊聊你的想法")}
										</small>
									</span>
									{session.id === snapshot?.id && <span className="session-active-dot" />}
								</button>
								<SessionActions
									session={session.id === snapshot?.id ? snapshot : session}
									disabled={pending || !coreReady}
									onAction={(action) => {
										const target = sessionRef.current?.id === session.id ? sessionRef.current : session;
										if (action === "archive")
											void performSessionAction(action, target).catch((reason) =>
												setError(reason instanceof Error ? reason.message : String(reason)),
											);
										else setSessionAction({ action, session: target });
									}}
								/>
							</div>
						))}
						{visibleSessions.length === 0 && (
							<p className="empty-list">
								{query
									? "没有找到相关对话"
									: archived
										? "还没有归档的对话"
										: "从一条消息开始，\n你的对话会保存在这里。"}
							</p>
						)}
					</nav>
					<footer className="sidebar-footer">
						<button type="button" onClick={() => setAssistantEditor("new")}>
							<Icon name="plus" /> 新建助手
						</button>
						<button type="button" onClick={() => setShowPluginSettings(true)}>
							<Icon name="plug" /> 插件
						</button>
						<button type="button" onClick={() => setShowModelSettings(true)}>
							<Icon name="settings" /> 设置
						</button>
					</footer>
				</aside>
				<main className="workspace" inert={narrow && (showSidebar || showDetails)}>
					<header className="chat-header">
						<button
							ref={sidebarToggle}
							type="button"
							className="circle-button mobile-only"
							aria-label="打开导航"
							aria-expanded={showSidebar}
							onClick={() => setShowSidebar(true)}
						>
							<Icon name="panel" />
						</button>
						<div className="chat-heading">
							<span className="header-avatar">
								<BotMark />
							</span>
							<div className="chat-title">
								<strong>{snapshot?.title ?? currentAssistant?.name ?? "Pie"}</strong>
								<span>
									<i className={coreReady && (!snapshot || connected) ? "online" : ""} />
									{connectionLabel}
								</span>
							</div>
						</div>
						<div className="chat-actions">
							{!busy && !interrupted && messages.length > 0 && (
								<button
									type="button"
									className="circle-button"
									disabled={pending || !connected}
									onClick={() => void retryLastMessage()}
									title="重试 / 编辑上一条（新分支）"
								>
									<Icon name="retry" />
									<span className="sr-only">重试 / 编辑上一条（新分支）</span>
								</button>
							)}
							<button
								type="button"
								className="model-pill"
								title={
									snapshot
										? snapshot.mode === "real"
											? "切换当前会话模型"
											: "本地试用会话详情"
										: "设置新会话默认模型"
								}
								onClick={() => (snapshot ? openDetails() : setShowModelSettings(true))}
							>
								{snapshot?.mode === "faux"
									? "本地试用 · 无模型调用"
									: (snapshot?.model ?? selectedModel?.id ?? "配置模型")}
							</button>
							<button
								type="button"
								className="circle-button"
								aria-label="打开会话详情"
								aria-expanded={showDetails}
								aria-controls="session-details"
								onClick={() => (showDetails ? setShowDetails(false) : openDetails())}
							>
								<Icon name="more" />
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
								<Icon name="close" />
							</button>
						</div>
					)}
					{notice && (
						<output className="notice">
							{notice}
							<button type="button" aria-label="关闭提示" onClick={() => setNotice("")}>
								<Icon name="close" />
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
										<BotMark />
									</div>
									<span className="welcome-eyebrow">{currentAssistant?.name ?? "Pie"}</span>
									<h1>有什么想一起完成的？</h1>
									<p>聊一个想法，解决一个问题，或者开始一项工作。</p>
									<div className="suggestions">
										{[
											["整理思路", "帮我把现在的想法整理成可执行计划"],
											["分析项目", "分析当前项目，指出最值得先做的三件事"],
											["开始任务", "先问我必要信息，然后开始完成任务"],
										].map(([label, prompt]) => (
											<button
												key={label}
												type="button"
												disabled={!coreReady || pending || Boolean(busy)}
												onClick={() => {
													const draft = readDraft(snapshot?.id ?? "new");
													setInitialDraft({
														...draft,
														text: draft.text ? `${draft.text}\n\n${prompt}` : prompt,
													});
												}}
											>
												<strong>{label}</strong>
												<Icon name="arrow-up" />
											</button>
										))}
									</div>
									{!selectedModel && (
										<button type="button" className="welcome-hint" onClick={() => setShowModelSettings(true)}>
											<Icon name="settings" /> 连接你的模型，开始对话 <Icon name="chevron" />
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
							{(messages.length > 0 || busy) && (
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
							)}
						</ThreadPrimitive.Viewport>
						{messages.length > 0 && (
							<ThreadPrimitive.ScrollToBottom className="scroll-bottom" aria-label="回到最新消息">
								<Icon name="arrow-down" /> 最新消息
							</ThreadPrimitive.ScrollToBottom>
						)}
						<div className="composer-area">
							{snapshot?.turn && snapshot.turn.status !== "running" && (
								<output
									className={`turn-status ${snapshot.turn.status} ${snapshot.turn.status === "completed" && !snapshot.execution.waitingForMessage ? "sr-only" : ""}`}
								>
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
							{snapshot && interrupted && (
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
							{snapshot?.execution.recoveryBlockedReason && (
								<p className="turn-status failed">{snapshot.execution.recoveryBlockedReason}</p>
							)}
							<Composer
								key={`${snapshot?.id ?? "new"}:${draftVersion}`}
								sessionId={snapshot?.id ?? "new"}
								initialDraft={initialDraft}
								disabled={
									loadingSession ||
									(snapshot
										? !connected ||
											(!snapshot.execution.actions.submit.available &&
												!snapshot.execution.actions.steer.available)
										: !coreReady)
								}
								pending={pending}
								running={Boolean(busy)}
								canStop={snapshot?.execution.actions.cancel.available ?? false}
								canSteer={snapshot?.execution.actions.steer.available ?? false}
								onSend={send}
								onStop={() => void cancel()}
							/>
							<p className="disclaimer">Enter 发送 · Shift + Enter 换行</p>
						</div>
					</ThreadPrimitive.Root>
				</main>
				{showDetails && (
					<button
						type="button"
						className="details-scrim"
						aria-label="关闭会话详情遮罩"
						onClick={() => setShowDetails(false)}
					/>
				)}
				{showDetails && (
					<div
						ref={detailsPanel}
						id="session-details"
						className="details-panel"
						role="dialog"
						aria-modal={narrow || undefined}
						aria-labelledby="session-details-title"
						onKeyDown={(event) => {
							if (!narrow || event.key !== "Tab") return;
							const controls = [
								...event.currentTarget.querySelectorAll<HTMLElement>(
									"button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary, [tabindex]:not([tabindex='-1'])",
								),
							].filter((control) => control.getClientRects().length > 0);
							const first = controls[0];
							const last = controls[controls.length - 1];
							if (
								(event.shiftKey && document.activeElement === first) ||
								(!event.shiftKey && document.activeElement === last)
							) {
								event.preventDefault();
								(event.shiftKey ? last : first)?.focus();
							}
						}}
					>
						<header>
							<div>
								<span className="dialog-kicker">SESSION</span>
								<h2 id="session-details-title">会话详情</h2>
							</div>
							<button
								type="button"
								className="circle-button"
								aria-label="关闭会话详情"
								onClick={() => setShowDetails(false)}
							>
								<Icon name="close" />
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
											void performSessionAction(
												"rename",
												snapshot,
												String(data.get("title") ?? "").trim(),
											).catch((reason) =>
												setError(reason instanceof Error ? reason.message : String(reason)),
											);
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
										onClick={() =>
											void performSessionAction("archive", snapshot).catch((reason) =>
												setError(reason instanceof Error ? reason.message : String(reason)),
											)
										}
									>
										{snapshot.archived ? "取消归档" : "归档会话"}
									</button>
									<button
										type="button"
										className="event-toggle danger"
										disabled={pending || busy || Boolean(interrupted)}
										onClick={() => setSessionAction({ action: "delete", session: snapshot })}
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
					</div>
				)}
			</div>
			{sessionAction && (
				<SessionActionDialog
					key={`${sessionAction.session.id}:${sessionAction.action}`}
					session={sessionAction.session}
					action={sessionAction.action}
					pending={pending}
					onClose={() => setSessionAction(undefined)}
					onConfirm={(title) => performSessionAction(sessionAction.action, sessionAction.session, title)}
				/>
			)}
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
