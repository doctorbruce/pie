export async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
	const response = await fetch(`/api${path}`, {
		method,
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok) {
		const payload = await response.json().catch(() => null);
		throw new Error(payload?.error ?? `服务请求失败：HTTP ${response.status}`);
	}
	return response.json();
}
