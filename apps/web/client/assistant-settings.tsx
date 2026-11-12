import type { Assistant, Plugin, ToolId, ToolInfo } from "@pie/runtime/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "./request.ts";

export function AssistantSettings({
	assistant,
	assistants,
	onClose,
	onSaved,
	onDeleted,
}: {
	assistant?: Assistant;
	assistants: Assistant[];
	onClose: () => void;
	onSaved: (assistant: Assistant) => void;
	onDeleted?: (id: string) => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [name, setName] = useState(assistant?.name ?? "");
	const [systemPrompt, setSystemPrompt] = useState(assistant?.systemPrompt ?? "请用中文回答，按需使用工具。");
	const [toolIds, setToolIds] = useState<ToolId[]>(assistant?.toolIds ?? []);
	const [pluginIds, setPluginIds] = useState<string[]>(assistant?.pluginIds ?? []);
	const [subagentIds, setSubagentIds] = useState<string[]>(assistant?.subagentIds ?? []);
	const [plugins, setPlugins] = useState<Plugin[]>([]);
	const [tools, setTools] = useState<ToolInfo[]>();
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(true);
	const load = useCallback(async () => {
		setLoading(true);
		setError("");
		try {
			const [plugins, tools] = await Promise.all([
				request<{ plugins: Plugin[] }>("/plugins"),
				request<{ tools: ToolInfo[] }>("/tools"),
			]);
			setPlugins(plugins.plugins);
			setTools(tools.tools);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setLoading(false);
		}
	}, []);
	useEffect(() => {
		dialog.current?.showModal();
		void load();
	}, [load]);
	return (
		<dialog
			ref={dialog}
			className="model-settings"
			aria-labelledby="assistant-settings-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!pending) onClose();
			}}
		>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					setPending(true);
					setError("");
					try {
						const saved = await request<Assistant>(
							assistant ? `/assistants/${assistant.id}` : "/assistants",
							assistant ? "PUT" : "POST",
							{ name: name.trim(), systemPrompt, toolIds, pluginIds, subagentIds },
						);
						onSaved(saved);
						onClose();
					} catch (error) {
						setError(error instanceof Error ? error.message : String(error));
					} finally {
						setPending(false);
					}
				}}
			>
				<div className="settings-heading">
					<h2 id="assistant-settings-title">{assistant ? "编辑助手" : "新建助手"}</h2>
				</div>
				<p className="settings-note">保存后，新配置会在已有会话下一次提交时生效。</p>
				{loading && <output>正在加载工具与插件…</output>}
				{!loading && !tools && (
					<button type="button" className="event-toggle" onClick={() => void load()}>
						重新加载配置
					</button>
				)}
				<fieldset disabled={pending || loading || !tools}>
					<label>
						助手名称
						<input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} />
					</label>
					<label>
						系统提示词
						<textarea
							rows={7}
							maxLength={16000}
							value={systemPrompt}
							onChange={(event) => setSystemPrompt(event.target.value)}
						/>
					</label>
					<p className="settings-note">可用工具</p>
					{[
						...(tools ?? []),
						...toolIds
							.filter((id) => tools && !tools.some((tool) => tool.id === id))
							.map((id) => ({ id, label: "已不可用，请取消选择" })),
					].map(({ id, label }) => (
						<label className="settings-checkbox" key={id}>
							<input
								type="checkbox"
								checked={toolIds.includes(id)}
								onChange={(event) =>
									setToolIds(event.target.checked ? [...toolIds, id] : toolIds.filter((item) => item !== id))
								}
							/>
							{id === label ? id : `${id} · ${label}`}
						</label>
					))}
					<p className="settings-note">
						挂载插件（自动提供 skill）。需要读参考文件或执行脚本时，请同时启用 read 及 bash 或 powershell。
					</p>
					{plugins.map((plugin) => (
						<label className="settings-checkbox" key={plugin.id}>
							<input
								type="checkbox"
								checked={pluginIds.includes(plugin.id)}
								onChange={(event) =>
									setPluginIds(
										event.target.checked
											? [...pluginIds, plugin.id]
											: pluginIds.filter((id) => id !== plugin.id),
									)
								}
							/>
							{plugin.name} · {plugin.skills.length} 个 Skill
						</label>
					))}
					{!plugins.length && <p className="settings-note">暂无插件，先从主界面的「插件」导入。</p>}
					<p className="settings-note">
						可调用助手（自动提供 task）。每次调用创建独立子会话，并使用目标助手的最新配置。
					</p>
					{assistants
						.filter((candidate) => candidate.id !== assistant?.id)
						.map((candidate) => (
							<label className="settings-checkbox" key={candidate.id}>
								<input
									type="checkbox"
									checked={subagentIds.includes(candidate.id)}
									onChange={(event) =>
										setSubagentIds(
											event.target.checked
												? [...subagentIds, candidate.id]
												: subagentIds.filter((id) => id !== candidate.id),
										)
									}
								/>
								{candidate.name}
							</label>
						))}
					{assistants.length <= (assistant ? 1 : 0) && (
						<p className="settings-note">暂无其他助手，请先创建目标助手。</p>
					)}
				</fieldset>
				{error && (
					<p role="alert" className="banner error">
						{error}
					</p>
				)}
				<div className="settings-actions">
					{assistant && (
						<button
							type="button"
							className="event-toggle"
							disabled={pending || assistants.length <= 1}
							title="至少保留一个助手；有会话或被其他助手调用时，请先移除关联"
							onClick={async () => {
								if (!window.confirm(`删除助手「${assistant.name}」？此操作无法撤销。`)) return;
								setPending(true);
								setError("");
								try {
									await request(`/assistants/${encodeURIComponent(assistant.id)}`, "DELETE");
									onDeleted?.(assistant.id);
									onClose();
								} catch (error) {
									setError(error instanceof Error ? error.message : String(error));
								} finally {
									setPending(false);
								}
							}}
						>
							删除助手
						</button>
					)}
					<button type="button" className="event-toggle" disabled={pending} onClick={onClose}>
						取消
					</button>
					<button type="submit" className="send-button" disabled={pending || loading || !tools || !name.trim()}>
						{pending ? "保存中…" : "保存助手"}
					</button>
				</div>
			</form>
		</dialog>
	);
}
