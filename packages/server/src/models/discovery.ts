import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "./resolve-config-value.ts";

export function endpointUrl(address: string): URL {
	const url = new URL(address);
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
		throw new Error("Base URL 必须为不含凭据、查询参数的 HTTP(S) 地址");
	url.pathname = url.pathname.replace(/\/+$/, "");
	return url;
}

/** Read-only discovery; never follow redirects carrying credentials or trust upstream pagination URLs. */
export async function discoverModels(
	config: { api: string; baseUrl: string; apiKey?: string; headers?: Record<string, string> },
	env: Record<string, string>,
) {
	const url = endpointUrl(config.baseUrl);
	const key = config.apiKey ? resolveConfigValueOrThrow(config.apiKey, "API key", env) : undefined;
	const headers = new Headers(resolveHeadersOrThrow(config.headers, "Provider", env));
	const google = config.api === "google-generative-ai";
	const anthropic = config.api === "anthropic-messages";
	if (anthropic) {
		if (!url.pathname.endsWith("/v1")) url.pathname += "/v1";
		headers.set("anthropic-version", "2023-06-01");
		if (key) headers.set("x-api-key", key);
	} else if (google) {
		if (!/\/v1(beta)?$/.test(url.pathname)) url.pathname += "/v1beta";
		if (key) headers.set("x-goog-api-key", key);
	} else if (["openai-completions", "openai-responses"].includes(config.api)) {
		if (key) headers.set("Authorization", `Bearer ${key}`);
	} else throw new Error("该协议暂不支持获取列表，请手动添加模型");
	url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
	const signal = AbortSignal.timeout(15000);
	const ids = new Set<string>();
	const cursors = new Set<string>();
	for (let page = 0; page < 10; page++) {
		const response = await fetch(url, { headers, signal, redirect: "error" });
		if (!response.ok) {
			await response.body?.cancel();
			throw new Error(`获取模型失败：HTTP ${response.status}`);
		}
		if (!response.body) throw new Error("模型列表为空响应");
		const reader = response.body.getReader();
		const chunks: Uint8Array[] = [];
		let length = 0;
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				length += value.byteLength;
				if (length > 2 * 1024 * 1024) throw new Error("模型列表响应超过 2 MiB");
				chunks.push(value);
			}
		} finally {
			await reader.cancel();
		}
		const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		if (!value || typeof value !== "object") throw new Error("模型列表格式无效");
		const payload = value as Record<string, unknown>;
		const entries = google ? payload.models : payload.data;
		if (!Array.isArray(entries)) throw new Error("模型列表格式无效");
		for (const entry of entries) {
			if (!entry || typeof entry !== "object") throw new Error("模型条目无效");
			if (
				google &&
				Array.isArray(entry.supportedGenerationMethods) &&
				!entry.supportedGenerationMethods.includes("generateContent")
			)
				continue;
			const id: unknown = google ? entry.name : entry.id;
			if (typeof id !== "string" || !id.trim() || id.length > 256) throw new Error("模型 ID 无效");
			ids.add(google ? id.replace(/^models\//, "") : id);
			if (ids.size > 2000) throw new Error("模型超过 2000 个，请手动添加");
		}
		const cursor = google ? payload.nextPageToken : payload.has_more ? payload.last_id : undefined;
		if (!cursor) {
			if (payload.has_more) throw new Error("模型分页缺少游标");
			return [...ids].sort().map((id) => ({ id }));
		}
		if (typeof cursor !== "string" || cursors.has(cursor)) throw new Error("模型分页游标无效");
		cursors.add(cursor);
		url.searchParams.set(google ? "pageToken" : "after_id", cursor);
	}
	throw new Error("模型列表分页超过 10 页，请手动添加");
}
