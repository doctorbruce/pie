import type { Plugin } from "@pie/server/protocol";
import { useEffect, useRef, useState } from "react";
import { request } from "./request.ts";

export function PluginSettings({ onClose }: { onClose: () => void }) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [plugins, setPlugins] = useState<Plugin[]>([]);
	const [path, setPath] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		dialog.current?.showModal();
		void request<{ plugins: Plugin[] }>("/plugins")
			.then((result) => setPlugins(result.plugins))
			.catch((error: unknown) => setError(error instanceof Error ? error.message : String(error)));
	}, []);
	async function operate(action: () => Promise<unknown>) {
		setPending(true);
		setError("");
		try {
			await action();
			setPlugins((await request<{ plugins: Plugin[] }>("/plugins")).plugins);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setPending(false);
		}
	}
	return (
		<dialog
			ref={dialog}
			className="model-settings"
			aria-labelledby="plugin-settings-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!pending) onClose();
			}}
		>
			<div className="settings-heading">
				<h2 id="plugin-settings-title">插件</h2>
			</div>
			<p className="settings-note">
				导入后，在「编辑助手」中挂载插件。已有会话保持原挂载，新建真实模型会话可使用 Skill。
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void operate(async () => {
						await request("/plugins/import", "POST", { path });
						setPath("");
					});
				}}
			>
				<fieldset disabled={pending}>
					<label>
						本地插件目录
						<input
							required
							value={path}
							onChange={(event) => setPath(event.target.value)}
							placeholder="包含 plugin.json 的绝对目录，ZIP 请先解压"
						/>
					</label>
					<p className="settings-note">
						复制到 Pie 数据目录，不自动安装依赖。仅导入受信任的插件；启用 shell 后命令以当前系统用户权限执行。
					</p>
					<button type="submit" className="send-button">
						{pending ? "处理中…" : "导入插件"}
					</button>
				</fieldset>
			</form>
			{plugins.map((plugin) => (
				<section key={plugin.id}>
					<h3>{plugin.name}</h3>
					<p className="settings-note">
						{plugin.id} · {plugin.summary}
					</p>
					<ul>
						{plugin.skills.map((skill) => (
							<li key={skill.id}>
								<code>{skill.name}</code> · {skill.description}
							</li>
						))}
					</ul>
					<button
						type="button"
						className="event-toggle"
						disabled={pending}
						onClick={() => {
							if (window.confirm(`卸载插件「${plugin.name}」？`))
								void operate(() => request(`/plugins/${encodeURIComponent(plugin.id)}`, "DELETE"));
						}}
					>
						卸载
					</button>
				</section>
			))}
			{!plugins.length && <p className="settings-note">暂无插件。</p>}
			{error && (
				<p role="alert" className="banner error">
					{error}
				</p>
			)}
			<div className="settings-actions">
				<button type="button" className="event-toggle" disabled={pending} onClick={onClose}>
					关闭
				</button>
			</div>
		</dialog>
	);
}
