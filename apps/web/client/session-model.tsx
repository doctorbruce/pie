import type { ModelCatalog, SessionSnapshot } from "@pie/runtime/protocol";
import { useEffect, useRef, useState } from "react";
import { request } from "./request.ts";

export function SessionModelSelect({
	session,
	disabled = false,
	onSaved,
}: {
	session: SessionSnapshot;
	disabled?: boolean;
	onSaved: (next: SessionSnapshot) => void;
}) {
	const [catalog, setCatalog] = useState<ModelCatalog>();
	const [loading, setLoading] = useState(true);
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [reload, setReload] = useState(0);
	const generation = useRef<{ sessionId: string; reload: number } | null>(null);
	const saving = useRef(false);
	useEffect(() => {
		const current = { sessionId: session.id, reload };
		generation.current = current;
		setLoading(true);
		setPending(false);
		saving.current = false;
		setError("");
		void request<ModelCatalog>("/models")
			.then((next) => {
				if (generation.current === current) setCatalog(next);
			})
			.catch((error: unknown) => {
				if (generation.current === current) setError(error instanceof Error ? error.message : String(error));
			})
			.finally(() => {
				if (generation.current === current) setLoading(false);
			});
		return () => {
			generation.current = null;
		};
	}, [session.id, reload]);
	const value = session.modelOverride
		? JSON.stringify([session.modelOverride.providerId, session.modelOverride.model])
		: "";
	const selectedUnavailable =
		session.modelOverride &&
		!catalog?.models.some(
			(model) => model.provider === session.modelOverride?.providerId && model.id === session.modelOverride?.model,
		);
	return (
		<div className="session-model">
			<label>
				<span className="sr-only">会话模型</span>
				<select
					aria-label="会话模型"
					title="切换在下一次发送时生效，不会改变正在执行的回复"
					value={value}
					disabled={disabled || loading || pending || session.kind === "subagent"}
					onChange={async (event) => {
						if (saving.current) return;
						const selected = catalog?.models.find(
							(model) => JSON.stringify([model.provider, model.id]) === event.target.value,
						);
						const current = generation.current;
						saving.current = true;
						setPending(true);
						setError("");
						try {
							const next = await request<SessionSnapshot>(
								`/sessions/${encodeURIComponent(session.id)}/model-override`,
								"PUT",
								{ modelOverride: selected ? { providerId: selected.provider, model: selected.id } : null },
							);
							if (generation.current === current) onSaved(next);
						} catch (error) {
							if (generation.current === current)
								setError(error instanceof Error ? error.message : String(error));
						} finally {
							if (generation.current === current) {
								saving.current = false;
								setPending(false);
							}
						}
					}}
				>
					<option value="">跟随默认模型{catalog?.selected ? ` · ${catalog.selected.id}` : ""}</option>
					{[
						{ label: "已配置", configured: true },
						{ label: "未配置", configured: false },
					].map(({ label, configured }) => (
						<optgroup key={label} label={label}>
							{!configured && selectedUnavailable && (
								<option value={value} disabled>
									{session.modelOverride?.providerId} / {session.modelOverride?.model}（未配置）
								</option>
							)}
							{catalog?.models
								.filter((model) => model.keyConfigured === configured)
								.map((model) => (
									<option
										key={JSON.stringify([model.provider, model.id])}
										value={JSON.stringify([model.provider, model.id])}
									>
										{model.provider} / {model.name || model.id}
										{!model.keyConfigured ? "（未配置密钥）" : ""}
									</option>
								))}
						</optgroup>
					))}
				</select>
			</label>
			{(loading || pending) && <output>{pending ? "保存中…" : "加载模型…"}</output>}
			{error && (
				<span role="alert">
					{error}
					<button type="button" className="event-toggle" onClick={() => setReload((value) => value + 1)}>
						刷新模型
					</button>
				</span>
			)}
			<small>
				下次发送生效 · 最近使用 {session.provider ? `${session.provider}/` : ""}
				{session.model}
			</small>
		</div>
	);
}
