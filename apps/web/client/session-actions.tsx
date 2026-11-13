import type { SessionSummary } from "@pie/runtime/protocol";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icons.tsx";

export type SessionAction = "rename" | "archive" | "delete";

export function SessionActions({
	session,
	disabled,
	onAction,
}: {
	session: SessionSummary;
	disabled: boolean;
	onAction: (action: SessionAction) => void;
}) {
	const id = useId();
	const trigger = useRef<HTMLButtonElement>(null);
	const menu = useRef<HTMLDivElement>(null);
	const [open, setOpen] = useState(false);
	const [position, setPosition] = useState({ top: 0, left: 0 });
	useEffect(() => {
		if (!open) return;
		const close = () => menu.current?.hidePopover();
		window.addEventListener("resize", close);
		window.addEventListener("scroll", close, true);
		return () => {
			window.removeEventListener("resize", close);
			window.removeEventListener("scroll", close, true);
		};
	}, [open]);
	const running = session.turn?.status === "running";
	return (
		<>
			<button
				ref={trigger}
				type="button"
				className="circle-button session-menu-trigger"
				aria-label={`会话操作：${session.title}`}
				title="会话操作"
				aria-haspopup="menu"
				aria-expanded={open}
				popoverTarget={id}
				disabled={disabled}
			>
				<Icon name="more" />
			</button>
			<div
				ref={menu}
				id={id}
				className="session-menu"
				popover="auto"
				role="menu"
				aria-label={`会话操作：${session.title}`}
				style={position}
				onToggle={(event) => {
					const opening = event.newState === "open";
					setOpen(opening);
					if (!opening || !trigger.current) return;
					const rect = trigger.current.getBoundingClientRect();
					const popover = event.currentTarget;
					setPosition({
						top: Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - popover.offsetHeight - 8)),
						left: Math.max(
							8,
							Math.min(rect.right - popover.offsetWidth, window.innerWidth - popover.offsetWidth - 8),
						),
					});
					popover.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
				}}
				onKeyDown={(event) => {
					if (event.key === "Escape") event.stopPropagation();
					if (event.key === "Tab") event.currentTarget.hidePopover();
					if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
					event.preventDefault();
					const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
					const focused = document.activeElement;
					const current = focused instanceof HTMLButtonElement ? items.indexOf(focused) : -1;
					const index =
						event.key === "Home"
							? 0
							: event.key === "End"
								? items.length - 1
								: (current + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
					items[index]?.focus();
				}}
			>
				<button
					type="button"
					role="menuitem"
					disabled={disabled || running}
					title={running ? "请在执行结束后重命名" : undefined}
					onClick={() => {
						menu.current?.hidePopover();
						onAction("rename");
					}}
				>
					<Icon name="pencil" /> 重命名
				</button>
				<button
					type="button"
					role="menuitem"
					disabled={disabled}
					onClick={() => {
						menu.current?.hidePopover();
						onAction("archive");
					}}
				>
					<Icon name="archive" /> {session.archived ? "取消归档" : "归档"}
				</button>
				<hr />
				<button
					type="button"
					role="menuitem"
					className="danger"
					disabled={disabled || running || session.turn?.status === "interrupted"}
					title={running || session.turn?.status === "interrupted" ? "请先结束当前执行" : undefined}
					onClick={() => {
						menu.current?.hidePopover();
						onAction("delete");
					}}
				>
					<Icon name="trash" /> 删除
				</button>
			</div>
		</>
	);
}

export function SessionActionDialog({
	session,
	action,
	pending,
	onClose,
	onConfirm,
}: {
	session: SessionSummary;
	action: "rename" | "delete";
	pending: boolean;
	onClose: () => void;
	onConfirm: (title: string) => Promise<void>;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const cancel = useRef<HTMLButtonElement>(null);
	const submitting = useRef(false);
	const [title, setTitle] = useState(session.title);
	const [error, setError] = useState("");
	const id = useId();
	const deleting = action === "delete";
	useEffect(() => {
		const previous = document.activeElement;
		const element = dialog.current;
		element?.showModal();
		if (input.current) {
			input.current.focus();
			input.current.select();
		} else cancel.current?.focus();
		return () => {
			element?.close();
			if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
			else document.getElementById("session-search")?.focus({ preventScroll: true });
		};
	}, []);
	useEffect(() => {
		if (error && !pending) (input.current ?? cancel.current)?.focus({ preventScroll: true });
	}, [error, pending]);
	return (
		<dialog
			ref={dialog}
			className="session-action-dialog"
			aria-labelledby={`${id}-title`}
			aria-describedby={`${id}-description`}
			onCancel={(event) => {
				event.preventDefault();
				if (!pending) onClose();
			}}
		>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (pending || submitting.current || (!deleting && !title.trim())) return;
					submitting.current = true;
					setError("");
					try {
						await onConfirm(title.trim());
						onClose();
					} catch (reason) {
						setError(reason instanceof Error ? reason.message : String(reason));
					} finally {
						submitting.current = false;
					}
				}}
			>
				<div className="settings-heading">
					<h2 id={`${id}-title`}>{deleting ? "删除会话？" : "重命名会话"}</h2>
					<button type="button" className="circle-button" aria-label="关闭" disabled={pending} onClick={onClose}>
						<Icon name="close" />
					</button>
				</div>
				<p id={`${id}-description`}>
					{deleting
						? `将永久删除「${session.title}」的全部消息及子会话。此操作无法撤销。`
						: "为这段对话取一个容易找到的名字。"}
				</p>
				{!deleting && (
					<label>
						会话名称
						<input
							ref={input}
							value={title}
							maxLength={100}
							required
							disabled={pending}
							onChange={(event) => setTitle(event.target.value)}
						/>
					</label>
				)}
				{error && (
					<p className="banner error" role="alert">
						{error}
					</p>
				)}
				<div className="dialog-actions">
					<button ref={cancel} type="button" disabled={pending} onClick={onClose}>
						取消
					</button>
					<button
						type="submit"
						className={deleting ? "danger-button" : "confirm-button"}
						disabled={pending || (!deleting && !title.trim())}
					>
						{pending ? (deleting ? "删除中…" : "保存中…") : deleting ? "确认删除" : "保存"}
					</button>
				</div>
			</form>
		</dialog>
	);
}
