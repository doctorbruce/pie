import type { SessionTree } from "@pie/runtime/protocol";
import { useEffect, useRef } from "react";
import { Icon } from "./icons.tsx";

export function SessionTreeDialog({
	tree,
	disabled,
	onClose,
	onSelect,
}: {
	tree: SessionTree;
	disabled: boolean;
	onClose: () => void;
	onSelect: (entryId: string) => void;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		dialog.current?.showModal();
	}, []);
	const children = new Map<string | null, SessionTree["entries"]>();
	for (const entry of tree.entries) {
		const siblings = children.get(entry.parentId) ?? [];
		siblings.push(entry);
		children.set(entry.parentId, siblings);
	}
	function renderBranch(parentId: string | null, depth: number): React.ReactNode {
		return children.get(parentId)?.map((entry) => (
			<div key={entry.id}>
				<button
					type="button"
					style={{ marginLeft: Math.min(depth, 12) * 12 }}
					disabled={disabled || !entry.selectable}
					onClick={() => onSelect(entry.id)}
				>
					<small>
						{entry.role === "user" ? "用户" : entry.role === "assistant" ? "助手" : "工具"} ·{" "}
						{entry.id === tree.leafId ? "当前节点" : entry.active ? "当前分支" : "其他分支"}
					</small>
					<span>{entry.text || "[无文本消息]"}</span>
				</button>
				{renderBranch(entry.id, depth + 1)}
			</div>
		));
	}
	return (
		<dialog
			ref={dialog}
			className="model-settings"
			aria-labelledby="tree-title"
			onCancel={(event) => {
				event.preventDefault();
				if (!disabled) onClose();
			}}
		>
			<div className="settings-heading">
				<div>
					<h2 id="tree-title">会话树</h2>
					<p>选择用户消息后可修改重发；选择回复可继续该分支。旧分支保留，不自动发送。</p>
				</div>
				<button
					type="button"
					className="circle-button"
					aria-label="关闭会话树"
					title="关闭"
					disabled={disabled}
					onClick={onClose}
				>
					<Icon name="close" />
					<span className="sr-only">关闭</span>
				</button>
			</div>
			<div className="fork-message-list">{renderBranch(null, 0)}</div>
		</dialog>
	);
}
