export class RequestError extends Error {
	readonly status: number;
	readonly reason?: string;
	constructor(message: string, status: number, reason?: string) {
		super(message);
		this.name = "RequestError";
		this.status = status;
		this.reason = reason;
	}
}

export async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
	const response = await fetch(`/api${path}`, {
		method,
		headers: body === undefined ? {} : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(30000),
	});
	if (!response.ok) {
		const payload = await response.json().catch(() => null);
		throw new RequestError(
			payload?.error ?? `服务请求失败：HTTP ${response.status}`,
			response.status,
			payload?.reason,
		);
	}
	return response.json();
}
