import type { ImagePart } from "@pie/runtime/protocol";
import { useEffect, useRef, useState } from "react";
import { store, stored } from "./storage.ts";

export type Draft = { text: string; images: ImagePart[] };
const drafts = new Map<string, Draft>();

export function Composer({
	sessionId,
	disabled,
	pending,
	running,
	canStop,
	canSteer,
	initialDraft,
	onSend,
	onStop,
}: {
	sessionId: string;
	disabled: boolean;
	pending: boolean;
	running: boolean;
	canStop: boolean;
	canSteer: boolean;
	initialDraft?: Draft;
	onSend: (draft: Draft) => Promise<boolean>;
	onStop: () => void;
}) {
	const [draft, setDraft] = useState<Draft>(
		() => initialDraft ?? drafts.get(sessionId) ?? { text: stored(`pie.draft.${sessionId}`), images: [] },
	);
	const [error, setError] = useState("");
	const [reading, setReading] = useState(false);
	const readingLock = useRef(false);
	const input = useRef<HTMLTextAreaElement>(null);
	const files = useRef<HTMLInputElement>(null);
	useEffect(() => {
		drafts.set(sessionId, draft);
		store(`pie.draft.${sessionId}`, draft.text);
		if (input.current) {
			input.current.style.height = "auto";
			input.current.style.height = `${Math.min(180, input.current.scrollHeight)}px`;
		}
	}, [draft, sessionId]);
	async function addImages(selected: File[]) {
		if (readingLock.current || pending || disabled) return;
		readingLock.current = true;
		setReading(true);
		setError("");
		try {
			if (draft.images.length + selected.length > 4) throw new Error("每条消息最多添加 4 张图片");
			const images: ImagePart[] = [];
			for (const file of selected) {
				if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error("支持 PNG、JPEG、WebP 和 GIF 图片");
				if (file.size > 4 * 1024 * 1024) throw new Error("单张图片不能超过 4 MiB");
				const data = await new Promise<string>((resolve, reject) => {
					const reader = new FileReader();
					reader.onload = () => resolve(String(reader.result).split(",")[1]);
					reader.onerror = () => reject(new Error("无法读取图片"));
					reader.readAsDataURL(file);
				});
				images.push({ type: "image", data, mimeType: file.type });
			}
			setDraft((current) => ({ ...current, images: [...current.images, ...images] }));
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : String(reason));
		} finally {
			readingLock.current = false;
			setReading(false);
		}
	}
	async function submit() {
		if (disabled || pending || reading || (running && !canSteer) || (!draft.text.trim() && !draft.images.length))
			return;
		if (await onSend(draft)) {
			drafts.delete(sessionId);
			store(`pie.draft.${sessionId}`, "");
			setDraft({ text: "", images: [] });
			input.current?.focus();
		}
	}
	return (
		<>
			{error && (
				<p className="banner error" role="alert">
					{error}
				</p>
			)}
			<form
				className="composer"
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				{draft.images.length > 0 && (
					<div className="attachment-list">
						{draft.images.map((image, index) => (
							<div key={`${index}:${image.data.slice(0, 30)}`}>
								<img src={`data:${image.mimeType};base64,${image.data}`} alt={`待发送图片 ${index + 1}`} />
								<button
									type="button"
									aria-label={`移除图片 ${index + 1}`}
									disabled={pending}
									onClick={() => setDraft({ ...draft, images: draft.images.filter((_, i) => i !== index) })}
								>
									×
								</button>
							</div>
						))}
					</div>
				)}
				<button
					type="button"
					className="composer-plus"
					aria-label="添加图片"
					title="添加图片（最多 4 张，每张 4 MiB）"
					disabled={disabled || pending || reading}
					onClick={() => files.current?.click()}
				>
					＋
				</button>
				<input
					ref={files}
					type="file"
					hidden
					accept="image/png,image/jpeg,image/webp,image/gif"
					multiple
					onChange={(event) => {
						void addImages(Array.from(event.target.files ?? []));
						event.target.value = "";
					}}
				/>
				<textarea
					ref={input}
					aria-label="发送消息"
					placeholder={
						disabled
							? "连接恢复或执行结束后可发送，草稿会保留"
							: running
								? "补充要求，发送后会引导当前执行…"
								: "给 Pie 发消息"
					}
					value={draft.text}
					maxLength={16000}
					disabled={pending}
					rows={2}
					onChange={(event) => setDraft({ ...draft, text: event.target.value })}
					onKeyDown={(event) => {
						if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
							event.preventDefault();
							void submit();
						}
					}}
					onPaste={(event) => {
						const images = Array.from(event.clipboardData.files).filter((file) => file.type.startsWith("image/"));
						if (images.length) {
							event.preventDefault();
							void addImages(images);
						}
					}}
				/>
				<div className="composer-footer">
					<span>
						{reading ? "正在读取图片…" : running ? "追加要求将引导当前执行" : "Enter 发送 · Shift + Enter 换行"}
					</span>
					<div className="composer-controls">
						{canStop && (
							<button
								type="button"
								className="send stop"
								aria-label="停止执行"
								disabled={pending}
								onClick={onStop}
							>
								■
							</button>
						)}
						<button
							type="submit"
							className="send"
							aria-label={running ? "追加要求" : "发送"}
							disabled={
								disabled ||
								pending ||
								reading ||
								(running && !canSteer) ||
								(!draft.text.trim() && !draft.images.length)
							}
						>
							↑
						</button>
					</div>
				</div>
			</form>
		</>
	);
}
