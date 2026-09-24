import type {
	ModelCatalog,
	ModelSelection,
	ProviderCatalog,
	ProviderModel,
	ProviderSettings,
} from "@pie/server/protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { request } from "./request.ts";

const protocols = [
	["openai-completions", "OpenAI Compatible"],
	["openai-responses", "OpenAI Responses"],
	["anthropic-messages", "Anthropic Messages"],
	["google-generative-ai", "Google Gemini"],
];
const emptyProvider: ProviderSettings = {
	id: "",
	name: "",
	api: "openai-completions",
	baseUrl: "",
	keyConfigured: false,
	models: [],
};

export function ModelSettings({
	onClose,
	onSaved,
}: {
	onClose: () => void;
	onSaved: (model: ModelSelection | undefined) => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const [catalog, setCatalog] = useState<ProviderCatalog>();
	const [builtins, setBuiltins] = useState<ModelCatalog["models"]>([]);
	const [editingId, setEditingId] = useState("");
	const [form, setForm] = useState(emptyProvider);
	const [apiKey, setApiKey] = useState("");
	const [showKey, setShowKey] = useState(false);
	const [modelId, setModelId] = useState("");
	const [defaultId, setDefaultId] = useState("");
	const [pending, setPending] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	const choose = useCallback((provider: ProviderSettings, selected?: ModelSelection) => {
		setForm(provider);
		setEditingId(provider.id);
		setApiKey("");
		setShowKey(false);
		setModelId("");
		setNotice("");
		setError("");
		setDefaultId(selected?.provider === provider.id ? selected.id : (provider.models[0]?.id ?? ""));
	}, []);
	useEffect(() => {
		dialog.current?.showModal();
		let active = true;
		void Promise.all([request<ProviderCatalog>("/providers"), request<ModelCatalog>("/models")])
			.then(([next, models]) => {
				if (!active) return;
				setCatalog(next);
				setBuiltins(models.models);
				const provider =
					next.providers.find((provider) => provider.id === next.selected?.provider) ?? next.providers[0];
				if (provider) choose(provider, next.selected);
			})
			.catch((error: unknown) => {
				if (active) setError(error instanceof Error ? error.message : String(error));
			});
		return () => {
			active = false;
		};
	}, [choose]);

	function add() {
		const id = modelId.trim();
		if (!id) return;
		if (id.length > 256 || form.models.some((model) => model.id === id)) {
			setError("模型 ID 已存在或超过 256 字符");
			return;
		}
		const known = builtins.find((model) => model.provider === form.id && model.id === id);
		setForm({
			...form,
			models: [
				...form.models,
				{
					id,
					contextWindow: known?.contextWindow ?? 128000,
					maxTokens: known?.maxTokens ?? 8192,
					reasoning: known?.reasoning ?? false,
				},
			],
		});
		setDefaultId(defaultId || id);
		setModelId("");
		setError("");
		setNotice("");
	}
	async function save() {
		if (modelId.trim()) {
			setError("请先点击「添加」，将输入的模型加入列表");
			return;
		}
		if (!form.models.length) {
			setError("请至少添加一个模型");
			return;
		}
		setPending(true);
		setError("");
		setNotice("");
		try {
			const next = await request<ProviderCatalog>("/providers/config", "PUT", {
				id: form.id,
				name: form.name,
				api: form.api,
				baseUrl: form.baseUrl,
				apiKey: apiKey || undefined,
				models: form.models,
				defaultModel: defaultId,
			});
			setCatalog(next);
			const provider = next.providers.find((provider) => provider.id === form.id);
			if (provider) choose(provider, next.selected);
			onSaved(next.selected);
			setNotice("已保存。新建真实模型会话后生效。");
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setPending(false);
		}
	}
	async function discover() {
		setPending(true);
		setError("");
		setNotice("");
		try {
			const next = await request<{ models: ProviderModel[] }>("/providers/discover", "POST", {
				id: form.id,
				name: form.name,
				api: form.api,
				baseUrl: form.baseUrl,
				apiKey: apiKey || undefined,
			});
			const added = next.models.filter((model) => !form.models.some((existing) => existing.id === model.id));
			setForm({ ...form, models: [...form.models, ...added] });
			setDefaultId(defaultId || added[0]?.id || "");
			setNotice(
				next.models.length
					? `获取到 ${next.models.length} 个模型，新增 ${added.length} 个。检查列表后保存。`
					: "接口返回空列表，可手动添加模型。",
			);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setPending(false);
		}
	}
	async function reload() {
		setPending(true);
		setError("");
		try {
			await request("/models/reload", "POST", {});
			const next = await request<ProviderCatalog>("/providers");
			setCatalog(next);
			choose(
				next.providers.find((provider) => provider.id === editingId) ?? next.providers[0] ?? emptyProvider,
				next.selected,
			);
			onSaved(next.selected);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setPending(false);
		}
	}
	return (
		<dialog
			className="model-settings"
			ref={dialog}
			onCancel={(event) => {
				if (pending) event.preventDefault();
				else onClose();
			}}
			aria-labelledby="settings-title"
		>
			<div className="settings-heading">
				<h2 id="settings-title">配置模型提供商</h2>
				<button type="button" className="event-toggle" disabled={pending} onClick={onClose}>
					关闭
				</button>
			</div>
			<p className="settings-note">一个提供商共用地址和密钥，可配置多个模型。</p>
			{error && (
				<p className="banner error" role="alert">
					{error}
				</p>
			)}
			{notice && <output className="settings-success">{notice}</output>}
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void save();
				}}
				onChange={() => setNotice("")}
			>
				<fieldset disabled={pending || !catalog}>
					<label>
						提供商
						<select
							value={editingId}
							onChange={(event) =>
								choose(
									catalog?.providers.find((provider) => provider.id === event.target.value) ?? emptyProvider,
									catalog?.selected,
								)
							}
						>
							<option value="">＋ 新增提供商</option>
							{catalog?.providers.map((provider) => (
								<option key={provider.id} value={provider.id}>
									{provider.name} · {provider.id}
								</option>
							))}
						</select>
					</label>
					<div className="settings-row">
						<label>
							提供商 ID
							<input
								required
								maxLength={100}
								readOnly={!!editingId}
								value={form.id}
								pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}"
								placeholder="例如：my-provider"
								onChange={(event) => {
									setForm({ ...form, id: event.target.value });
									setApiKey("");
								}}
							/>
						</label>
						<label>
							提供商名称
							<input
								required
								value={form.name}
								placeholder="输入提供商名称"
								onChange={(event) => setForm({ ...form, name: event.target.value })}
							/>
						</label>
					</div>
					<label>
						接口协议
						<select value={form.api} onChange={(event) => setForm({ ...form, api: event.target.value })}>
							{protocols.map(([id, label]) => (
								<option key={id} value={id}>
									{label}
								</option>
							))}
							{!protocols.some(([id]) => id === form.api) && <option value={form.api}>{form.api}</option>}
						</select>
					</label>
					<label>
						Base URL
						<input
							type="url"
							required
							value={form.baseUrl}
							placeholder="例如：https://api.example.com/v1"
							onChange={(event) => setForm({ ...form, baseUrl: event.target.value })}
						/>
					</label>
					<label htmlFor="provider-key">API Key</label>
					<div className="key-input">
						<input
							id="provider-key"
							type={showKey ? "text" : "password"}
							autoComplete="new-password"
							value={apiKey}
							placeholder={form.keyConfigured ? "已配置，留空保留" : "输入 API Key 或 $ENV_VAR"}
							onChange={(event) => setApiKey(event.target.value)}
						/>
						<button
							type="button"
							className="event-toggle"
							aria-label={showKey ? "隐藏密钥" : "显示密钥"}
							onClick={() => setShowKey(!showKey)}
						>
							{showKey ? "隐藏" : "显示"}
						</button>
					</div>
					<label htmlFor="new-model">模型列表</label>
					<div className="model-add">
						<input
							id="new-model"
							list="model-candidates"
							value={modelId}
							maxLength={256}
							placeholder="例如：deepseek-chat"
							onChange={(event) => setModelId(event.target.value)}
						/>
						<button
							type="button"
							className="event-toggle"
							onClick={() => void discover()}
							disabled={!form.id || !form.name || !form.baseUrl}
						>
							获取
						</button>
						<button type="button" className="event-toggle" disabled={!modelId.trim()} onClick={add}>
							添加
						</button>
					</div>
					<datalist id="model-candidates">
						{builtins
							.filter((model) => model.provider === form.id)
							.map((model) => (
								<option key={model.id} value={model.id} />
							))}
					</datalist>
					<div className="provider-models">
						{form.models.map((model) => (
							<div className="provider-model" key={model.id}>
								<div className="model-item">
									<code>{model.id}</code>
									<button
										type="button"
										className="event-toggle"
										aria-label={`移除模型 ${model.id}`}
										onClick={() => {
											const models = form.models.filter((entry) => entry.id !== model.id);
											setForm({ ...form, models });
											if (defaultId === model.id) setDefaultId(models[0]?.id ?? "");
										}}
									>
										移除
									</button>
								</div>
								<details className="model-advanced">
									<summary>高级设置</summary>
									<div className="settings-row">
										<label>
											上下文窗口
											<input
												type="number"
												min={1}
												required
												value={model.contextWindow ?? 128000}
												onChange={(event) =>
													setForm({
														...form,
														models: form.models.map((entry) =>
															entry.id === model.id
																? { ...entry, contextWindow: Number(event.target.value) }
																: entry,
														),
													})
												}
											/>
										</label>
										<label>
											最大输出 tokens
											<input
												type="number"
												min={1}
												required
												value={model.maxTokens ?? 16384}
												onChange={(event) =>
													setForm({
														...form,
														models: form.models.map((entry) =>
															entry.id === model.id
																? { ...entry, maxTokens: Number(event.target.value) }
																: entry,
														),
													})
												}
											/>
										</label>
									</div>
									<label className="settings-checkbox">
										<input
											type="checkbox"
											checked={model.reasoning ?? false}
											onChange={(event) =>
												setForm({
													...form,
													models: form.models.map((entry) =>
														entry.id === model.id ? { ...entry, reasoning: event.target.checked } : entry,
													),
												})
											}
										/>
										支持推理
									</label>
								</details>
							</div>
						))}
					</div>
					{form.models.length > 0 && (
						<label>
							新会话默认模型
							<select value={defaultId} onChange={(event) => setDefaultId(event.target.value)}>
								{form.models.map((model) => (
									<option key={model.id} value={model.id}>
										{model.id}
									</option>
								))}
							</select>
						</label>
					)}
					<p className="settings-note">
						密钥只保存在服务端，留空不会覆盖。获取失败时可手动添加，保存不会调用模型。
					</p>
					<div className="settings-actions">
						<button type="button" className="event-toggle" onClick={() => void reload()}>
							重新加载文件
						</button>
						<button type="submit" className="send-button">
							{pending ? "处理中…" : "保存"}
						</button>
					</div>
				</fieldset>
			</form>
		</dialog>
	);
}
