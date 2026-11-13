const paths = {
	search: "m20.5 20.5-4.4-4.4M18 10.5a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z",
	plus: "M12 5v14M5 12h14",
	close: "m6 6 12 12M18 6 6 18",
	more: "M5 11.5v1M12 11.5v1M19 11.5v1",
	settings:
		"m9 3-.7 2.3-2 .9-2.2-.6-1.5 2.6 1.6 1.8-.2 2.2-1.4 1.8 1.5 2.6 2.3-.5 1.8 1.3.4 2.3h3l.7-2.3 2-.9 2.2.6 1.5-2.6-1.6-1.8.2-2.2 1.4-1.8-1.5-2.6-2.3.5-1.8-1.3L12 3Zm5.5 9a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
	archive: "M4 8v11h16V8M3 4h18v4H3ZM9 12h6",
	trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7",
	check: "m5 12 4 4L19 6",
	chevron: "m7 10 5 5 5-5",
	"arrow-up": "M12 19V5m-6 6 6-6 6 6",
	stop: "M7 7h10v10H7Z",
	copy: "M9 8V4h11v12h-4M4 8h12v12H4Z",
	chat: "M20 4H4v12h4v4l5-4h7Z",
	panel: "M3 4h18v16H3ZM9 4v16",
	retry: "M4 10a8 8 0 1 1 1.5 7M4 4v6h6",
	plug: "M12 22v-5M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-12 0V8Z",
	grid: "M4 4h6v6H4Zm10 0h6v6h-6ZM4 14h6v6H4Zm10 0h6v6h-6Z",
	pencil: "m4 16 11-11 4 4L8 20H4Zm8-8 4 4m-1-7 2-2 4 4-2 2",
	"arrow-down": "M12 5v14m-6-6 6 6 6-6",
};

export type IconName = keyof typeof paths;

export function Icon({ name, className = "" }: { name: IconName; className?: string }) {
	return (
		<svg
			className={`ui-icon ${className}`.trim()}
			width="18"
			height="18"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.7"
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
		>
			<path d={paths[name]} />
		</svg>
	);
}

export function BotMark({ className = "" }: { className?: string }) {
	return (
		<svg
			className={`bot-mark ${className}`.trim()}
			width="28"
			height="28"
			viewBox="0 0 32 32"
			fill="none"
			stroke="currentColor"
			strokeWidth="4"
			strokeLinecap="round"
			aria-hidden="true"
			focusable="false"
		>
			<path d="m9 12 3 6m7-9 3 6" />
		</svg>
	);
}
