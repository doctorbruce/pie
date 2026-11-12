import type { BackgroundJobCancellationReceipt, BackgroundJobList } from "@pie/runtime/jobs";
import { useEffect, useRef, useState } from "react";
import { request } from "./request.ts";

const statusLabels = { running: "执行中", completed: "已结束", failed: "失败", cancelled: "已取消" };

export function BackgroundJobs({ sessionId }: { sessionId: string }) {
	const [list, setList] = useState<BackgroundJobList>();
	const [error, setError] = useState("");
	const [pending, setPending] = useState("");
	const [reload, setReload] = useState(0);
	const generation = useRef<{ sessionId: string; reload: number } | null>(null);
	useEffect(() => {
		const current = { sessionId, reload };
		generation.current = current;
		let timer: ReturnType<typeof setTimeout>;
		setList(undefined);
		setPending("");
		setError("");
		async function refresh() {
			try {
				const next = await request<BackgroundJobList>(`/sessions/${encodeURIComponent(sessionId)}/jobs`);
				if (generation.current !== current) return;
				setList(next);
				setError("");
			} catch (error) {
				if (generation.current !== current) return;
				setError(error instanceof Error ? error.message : String(error));
			}
			if (generation.current === current) timer = setTimeout(() => void refresh(), 3000);
		}
		void refresh();
		return () => {
			generation.current = null;
			clearTimeout(timer);
		};
	}, [sessionId, reload]);
	return (
		<details className="background-jobs">
			<summary>
				后台作业{list ? ` · ${list.jobs.filter((job) => job.status === "running").length} 项执行中` : ""}
			</summary>
			<p className="settings-note">仅显示当前 Core 实例的作业；作业结束不代表会话中的业务目标已经完成。</p>
			{!list && !error && <output>正在加载作业…</output>}
			{list?.jobs.length === 0 && <p className="settings-note">当前实例暂无作业。</p>}
			{list?.jobs.map((job) => (
				<section key={job.executionId} className="job-card">
					<strong>{job.title}</strong>
					<span>{statusLabels[job.status]}</span>
					{job.error && <p className="banner error">{job.error}</p>}
					{job.status === "running" && (
						<button
							type="button"
							className="event-toggle"
							disabled={!!pending}
							onClick={async () => {
								if (!window.confirm(`取消后台作业「${job.title}」？`)) return;
								const current = generation.current;
								setPending(job.executionId);
								setError("");
								try {
									await request<BackgroundJobCancellationReceipt>(
										`/sessions/${encodeURIComponent(sessionId)}/jobs/${encodeURIComponent(job.id)}/cancel`,
										"POST",
										{ instanceId: list.instanceId, executionId: job.executionId },
									);
									if (generation.current === current) setReload((value) => value + 1);
								} catch (error) {
									if (generation.current === current)
										setError(error instanceof Error ? error.message : String(error));
								} finally {
									if (generation.current === current) setPending("");
								}
							}}
						>
							{pending === job.executionId ? "取消中…" : "取消作业"}
						</button>
					)}
				</section>
			))}
			{error && (
				<p role="alert" className="banner error">
					{error}
					<button type="button" className="event-toggle" onClick={() => setReload((value) => value + 1)}>
						重新加载作业
					</button>
				</p>
			)}
		</details>
	);
}
