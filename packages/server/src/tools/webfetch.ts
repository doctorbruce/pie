import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "@earendil-works/pi-ai";
import { Parser } from "htmlparser2";
import TurndownService from "turndown";
import type { ToolRuntime } from "./runtime.ts";
import { MAX_BYTES, MAX_LINES, truncateHead } from "./shared.ts";

export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_TIMEOUT_SECONDS = 30;
export const MAX_TIMEOUT_SECONDS = 120;

const parameters = Type.Object(
	{
		url: Type.String({ description: "The HTTP or HTTPS URL to fetch content from" }),
		format: Type.Optional(
			Type.Union([Type.Literal("text"), Type.Literal("markdown"), Type.Literal("html")], {
				default: "markdown",
				description: "The format to return the content in. Defaults to markdown.",
			}),
		),
		timeout: Type.Optional(
			Type.Number({
				exclusiveMinimum: 0,
				maximum: MAX_TIMEOUT_SECONDS,
				description: `Optional timeout in seconds (maximum: ${MAX_TIMEOUT_SECONDS})`,
			}),
		),
	},
	{ additionalProperties: false },
);

type WebFetchDetails = {
	url: string;
	sourceUrl?: string;
	contentType: string;
	format: "text" | "markdown" | "html";
	truncated: boolean;
	outputPath?: string;
};

export function webFetchTool(runtime: ToolRuntime): AgentTool<typeof parameters, WebFetchDetails> {
	return {
		name: "webfetch",
		label: "抓取网页",
		description: `Fetch content from an HTTP or HTTPS URL and return it as text, markdown, or HTML. Markdown is the default. Use a more targeted tool when one is available. This tool is read-only. Bilibili public video pages blocked with HTTP 412 may fall back to the same video's official mobile page; page text is not a video transcript. Requests default to ${DEFAULT_TIMEOUT_SECONDS} seconds, with a maximum of ${MAX_TIMEOUT_SECONDS} seconds and ${MAX_RESPONSE_BYTES / 1024 / 1024} MiB per response. Large text results are replaced with a preview while the complete output is saved to a file that can be inspected with read.`,
		parameters,
		async execute(_id, { url, format = "markdown", timeout = DEFAULT_TIMEOUT_SECONDS }, signal) {
			signal?.throwIfAborted();
			const parsed = new URL(url);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
				throw new Error("URL must use http:// or https://");
			await runtime.ask(
				{
					type: "confirmation",
					title: "访问网页",
					message: url,
					metadata: { permission: "webfetch", resources: [url], url, format, timeout },
				},
				signal,
			);
			signal?.throwIfAborted();
			const controller = new AbortController();
			const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
			const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeout * 1000);
			const headers = {
				"User-Agent":
					"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
				Accept: {
					markdown: "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1",
					text: "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1",
					html: "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1",
				}[format],
				"Accept-Language": "en-US,en;q=0.9",
			};
			let response: Response | undefined;
			let sourceUrl: string | undefined;
			try {
				response = await fetch(url, { headers, signal: requestSignal });
				if (response.status === 403 && response.headers.get("cf-mitigated") === "challenge") {
					await response.body?.cancel();
					headers["User-Agent"] = "opencode";
					response = await fetch(url, { headers, signal: requestSignal });
				}
				if (
					response.status === 412 &&
					["bilibili.com", "www.bilibili.com", "m.bilibili.com"].includes(parsed.hostname) &&
					!parsed.port &&
					/^\/video\/(?:BV[0-9A-Za-z]{10}|av\d+)\/?$/.test(parsed.pathname)
				) {
					await response.body?.cancel();
					const mobileUrl = new URL(url);
					mobileUrl.protocol = "https:";
					mobileUrl.hostname = "m.bilibili.com";
					mobileUrl.pathname = mobileUrl.pathname.replace(/\/$/, "");
					mobileUrl.hash = "";
					sourceUrl = mobileUrl.href;
					await runtime.ask(
						{
							type: "confirmation",
							title: "访问网页",
							message: `原网页返回 HTTP 412，改读同一视频的官方移动页：\n${sourceUrl}`,
							metadata: { permission: "webfetch", resources: [sourceUrl], url: sourceUrl, format, timeout },
						},
						requestSignal,
					);
					requestSignal.throwIfAborted();
					headers["User-Agent"] =
						"Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
					response = await fetch(sourceUrl, { headers, signal: requestSignal });
				}
				if (!response.ok) throw new Error(`Request failed with status code: ${response.status}`);
				const contentType = response.headers.get("content-type") || "";
				const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
				if (mime.startsWith("image/") && mime !== "image/svg+xml" && mime !== "image/vnd.fastbidsheet")
					throw new Error(`Unsupported fetched image content type: ${mime}`);
				if (
					mime &&
					!mime.startsWith("text/") &&
					!["application/json", "application/xml", "application/javascript", "application/x-javascript"].includes(
						mime,
					) &&
					!mime.endsWith("+json") &&
					!mime.endsWith("+xml")
				)
					throw new Error(`Unsupported fetched file content type: ${mime}`);
				const parsedSize = Number.parseInt(response.headers.get("content-length") ?? "", 10);
				const declaredSize = Number.isSafeInteger(parsedSize) && parsedSize >= 0 ? parsedSize : undefined;
				if (declaredSize !== undefined && declaredSize > MAX_RESPONSE_BYTES)
					throw new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`);
				let body = Buffer.allocUnsafe(Math.min(MAX_RESPONSE_BYTES, declaredSize || 64 * 1024));
				let size = 0;
				const reader = response.body?.getReader();
				if (reader) {
					try {
						for (;;) {
							const chunk = await reader.read();
							if (chunk.done) break;
							if (size + chunk.value.byteLength > MAX_RESPONSE_BYTES)
								throw new Error(`Response too large (exceeds ${MAX_RESPONSE_BYTES} byte limit)`);
							if (size + chunk.value.byteLength > body.byteLength) {
								const grown = Buffer.allocUnsafe(
									Math.min(MAX_RESPONSE_BYTES, Math.max(size + chunk.value.byteLength, body.byteLength * 2)),
								);
								body.copy(grown, 0, 0, size);
								body = grown;
							}
							body.set(chunk.value, size);
							size += chunk.value.byteLength;
						}
					} finally {
						reader.releaseLock();
					}
				}
				requestSignal.throwIfAborted();
				const content = new TextDecoder().decode(body.subarray(0, size));
				const converted =
					mime === "text/html"
						? format === "markdown"
							? convertHTMLToMarkdown(content)
							: format === "text"
								? extractTextFromHTML(content)
								: content
						: content;
				const output =
					sourceUrl && format !== "html"
						? `Source: ${sourceUrl}\n[Public mobile page text only; not a video transcript.]\n\n${converted}`
						: converted;
				const limited = truncateHead(output);
				let text = limited.content;
				let outputPath: string | undefined;
				if (limited.truncated) {
					outputPath = join(await mkdtemp(join(tmpdir(), "pie-webfetch-")), "output.txt");
					await writeFile(outputPath, output, "utf8");
					const preview =
						limited.content || new StringDecoder("utf8").write(Buffer.from(output).subarray(0, MAX_BYTES));
					text = `${preview}\n\n[Output truncated to ${MAX_LINES} lines or ${MAX_BYTES / 1024} KiB. Full output saved to: ${outputPath}. Use read to inspect it.]`;
				}
				requestSignal.throwIfAborted();
				return {
					content: [{ type: "text", text }],
					details: {
						url,
						...(sourceUrl ? { sourceUrl } : {}),
						contentType,
						format,
						truncated: limited.truncated,
						outputPath,
					},
				};
			} catch (error) {
				requestSignal.throwIfAborted();
				throw error;
			} finally {
				clearTimeout(timer);
				await response?.body?.cancel().catch(() => {});
			}
		},
	};
}

export function extractTextFromHTML(html: string): string {
	let text = "";
	let skipDepth = 0;
	const parser = new Parser({
		onopentag(name) {
			if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) skipDepth++;
		},
		ontext(input) {
			if (skipDepth === 0) text += input;
		},
		onclosetag() {
			if (skipDepth > 0) skipDepth--;
		},
	});
	parser.write(html);
	parser.end();
	return text.trim();
}

export function convertHTMLToMarkdown(html: string): string {
	const turndown = new TurndownService({
		headingStyle: "atx",
		hr: "---",
		bulletListMarker: "-",
		codeBlockStyle: "fenced",
		emDelimiter: "*",
	});
	turndown.remove(["script", "style", "meta", "link"]);
	return turndown.turndown(html);
}
