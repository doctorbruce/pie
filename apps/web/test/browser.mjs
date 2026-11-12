import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startChatHost } from "../host.ts";

// Requires a local Chrome binary; all model responses and test data are local.
const artifacts = process.env.PI_BROWSER_ARTIFACTS ?? (await mkdtemp(join(tmpdir(), "pie-browser-results-")));
await mkdir(artifacts, { recursive: true });
const directory = await mkdtemp(join(tmpdir(), "pie-browser-data-"));
const profile = await mkdtemp(join(tmpdir(), "pie-browser-profile-"));
const results = [];
const errors = [];
const packets = [];
const network = [];
let chrome;
let host;
let cdp;
let session;
let chromeLog = "";
let failedBootstrap = false;
let notifyBootstrapFailure;
const bootstrapFailed = new Promise((resolve) => { notifyBootstrapFailure = resolve; });

class CDP {
	constructor(socket) {
		this.socket = socket;
		this.nextId = 0;
		this.pending = new Map();
		this.events = new Set();
		socket.addEventListener("message", ({ data }) => {
			const message = JSON.parse(String(data));
			if (message.id) {
				const pending = this.pending.get(message.id);
				if (!pending) return;
				this.pending.delete(message.id);
				clearTimeout(pending.timer);
				if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
				else pending.resolve(message.result);
			} else for (const event of this.events) event(message);
		});
	}
	send(method, params = {}, sessionId = session) {
		const id = ++this.nextId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`CDP timeout: ${method}`));
			}, 15000);
			this.pending.set(id, { resolve, reject, timer });
			this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
		});
	}
}

async function evaluate(expression) {
	const response = await cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
	return response.result.value;
}

async function waitFor(expression, label, timeout = 15000) {
	const start = Date.now();
	while (Date.now() - start < timeout) {
		if (await evaluate(`Boolean(${expression})`)) return;
		await new Promise((resolve) => setTimeout(resolve, 75));
	}
	throw new Error(`浏览器等待超时：${label}`);
}

async function click(selector) {
	await waitFor(
		`(() => { const node = document.querySelector(${JSON.stringify(selector)}); return node && !node.disabled && node.getClientRects().length > 0; })()`,
		`可点击 ${selector}`,
	);
	await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
}

async function clickText(text, root = "document") {
	const expression = `Array.from(${root}.querySelectorAll('button')).find(node => node.textContent.trim() === ${JSON.stringify(text)})`;
	await waitFor(`(() => { const node = ${expression}; return node && !node.disabled; })()`, `按钮 ${text}`);
	await evaluate(`(${expression}).click()`);
}

async function fill(selector, text) {
	await evaluate(`(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.focus(); input.select(); })()`);
	await cdp.send("Input.insertText", { text });
	await waitFor(`document.querySelector(${JSON.stringify(selector)}).value === ${JSON.stringify(text)}`, `输入 ${selector}`);
}

async function api(path, method = "GET", body) {
	const response = await fetch(`${host.url}/api${path}`, {
		method,
		headers: { "Content-Type": "application/json", Origin: host.url },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	const result = await response.json();
	assert(response.ok, `${method} ${path}: ${JSON.stringify(result)}`);
	return result;
}

async function settled(id, expected = "completed") {
	const start = Date.now();
	while (Date.now() - start < 15000) {
		const current = await api(`/sessions/${id}`);
		if (current.turn && current.turn.status !== "running") {
			assert.equal(current.turn.status, expected, current.turn.error);
			await waitFor("!document.querySelector('.running-indicator')", "执行结算后的界面");
			return current;
		}
		await new Promise((resolve) => setTimeout(resolve, 75));
	}
	throw new Error(`Turn 未结算：${id}`);
}

async function send(text) {
	await fill('textarea[aria-label="发送消息"]', text);
	await click('.composer button[type="submit"]');
	await waitFor("document.querySelector('.running-indicator')", "流式执行开始");
}

async function screenshot(name) {
	const { data } = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
	await writeFile(join(artifacts, `${name}.png`), Buffer.from(data, "base64"));
}

async function step(name, run) {
	const start = Date.now();
	await run();
	results.push({ name, elapsedMs: Date.now() - start, passed: true });
	console.log(`通过：${name}`);
}

try {
	const crashFixture = fileURLToPath(new URL("../../../packages/server/test/fixtures/turn-crash.ts", import.meta.url));
	const { stdout } = await promisify(execFile)(process.execPath, ["--conditions=source", crashFixture, directory, "user"], {
		timeout: 30000,
		encoding: "utf8",
	});
	const recovery = JSON.parse(stdout.trim());
	host = await startChatHost({
		environment: { PI_DATA_DIR: directory, PI_TOOLS_DIR: directory, PI_TURN_RECOVERY: "manual", PI_TOOL_STREAM_TRACE: "0", PI_MODEL_REQUEST_RECORDING: "0" },
		port: 0,
	});
	const assistant = await api("/assistants", "POST", {
		name: "浏览器验收助手",
		systemPrompt: "本地浏览器回归，只执行用户明确指定的测试命令。",
		toolIds: ["bash"],
	});
	const history = await api("/sessions", "POST", {
		assistantId: assistant.id,
		mode: "faux",
		title: "历史分页验收",
		workspacePath: directory,
	});
	await api(`/sessions/${history.id}/import`, "PUT", {
		schemaVersion: 1,
		source: { astronSessionId: "browser-history", coreId: "pie", sessionId: history.id },
		title: "历史分页验收",
		transcript: Array.from({ length: 64 }, (_, index) => ({
			id: `browser-history-${index}`,
			role: index % 2 ? "assistant" : "user",
			content: [{ type: "text", text: `历史消息 ${String(index).padStart(2, "0")}` }],
			createdAt: index + 1,
		})),
	});
	const chat = await api("/sessions", "POST", {
		assistantId: assistant.id,
		mode: "faux",
		title: "浏览器主会话",
		workspacePath: directory,
	});
	chrome = spawn(process.env.PI_CHROME ?? "/usr/bin/google-chrome", [
		"--headless=new",
		"--no-sandbox",
		"--disable-dev-shm-usage",
		"--disable-gpu",
		"--no-first-run",
		"--no-default-browser-check",
		"--remote-debugging-port=0",
		`--user-data-dir=${profile}`,
		"about:blank",
	], { stdio: ["ignore", "ignore", "pipe"] });
	const debugUrl = await new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`Chrome 未启动：${chromeLog}`)), 15000);
		chrome.once("error", reject);
		chrome.stderr.on("data", (data) => {
			chromeLog = (chromeLog + data).slice(-20000);
			const match = /DevTools listening on (ws:\/\/\S+)/.exec(chromeLog);
			if (match) {
				clearTimeout(timer);
				resolve(match[1]);
			}
		});
	});
	const socket = new WebSocket(debugUrl);
	await once(socket, "open");
	cdp = new CDP(socket);
	const target = await cdp.send("Target.createTarget", { url: "about:blank" }, undefined);
	({ sessionId: session } = await cdp.send("Target.attachToTarget", { targetId: target.targetId, flatten: true }, undefined));
	cdp.events.add((event) => {
		if (event.method === "Page.javascriptDialogOpening")
			void cdp.send("Page.handleJavaScriptDialog", { accept: true }).catch((error) => errors.push(String(error)));
		if (event.method === "Fetch.requestPaused") {
			if (!failedBootstrap && new URL(event.params.request.url).pathname === "/api/providers") {
				failedBootstrap = true;
				void cdp.send("Fetch.failRequest", { requestId: event.params.requestId, errorReason: "Failed" });
				notifyBootstrapFailure();
			} else void cdp.send("Fetch.continueRequest", { requestId: event.params.requestId });
		}
		if (event.method === "Network.loadingFailed" || event.method === "Network.requestWillBeSent")
			network.push({ method: event.method, params: event.params });
		if (event.method === "Runtime.exceptionThrown") errors.push(event.params.exceptionDetails);
		if (event.method === "Runtime.consoleAPICalled" && event.params.type === "error")
			errors.push(event.params.args.map((arg) => arg.value ?? arg.description).join(" "));
		if (event.method === "Network.eventSourceMessageReceived") {
			try { packets.push(JSON.parse(event.params.data)); } catch { /* The UI owns malformed-packet recovery. */ }
		}
	});
	await cdp.send("Runtime.enable");
	await cdp.send("Network.enable");
	await cdp.send("Page.enable");
	await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "*/api/providers", requestStage: "Request" }] });
	await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
	await step("首次配置请求失败后自动恢复初始化", async () => {
		await cdp.send("Page.navigate", { url: host.url });
		let timer;
		try {
			await Promise.race([
				bootstrapFailed,
				new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("首个模型配置请求未出现")), 20000); }),
			]);
		} finally { clearTimeout(timer); }
		await waitFor("document.querySelector('.banner.error')", "首次初始化失败");
		assert(failedBootstrap);
		await waitFor("document.querySelector('.chat-title strong')?.textContent === '浏览器主会话' && document.querySelector('.chat-title')?.textContent.includes('Core 已连接') && document.querySelector('#assistant-select')?.options.length >= 2", "五秒自动重试恢复", 20000);
		await cdp.send("Fetch.disable");
	});
	await step("手动恢复中断执行并保留原 Turn 身份", async () => {
		await evaluate("Array.from(document.querySelectorAll('.session-row')).find(node => node.querySelector('strong')?.textContent === '新会话').click()");
		await waitFor("document.querySelector('.turn-status.interrupted')", "安全中断恢复状态");
		await clickText("继续", "document.querySelector('.resume-actions')");
		const current = await settled(recovery.sessionId);
		assert.equal(current.turn.id, recovery.turnId);
		assert.equal(current.messages.filter((message) => message.role === "user").length, 1);
		await evaluate("Array.from(document.querySelectorAll('.session-row')).find(node => node.querySelector('strong')?.textContent === '浏览器主会话').click()");
		await waitFor("document.querySelector('.chat-title strong')?.textContent === '浏览器主会话' && document.querySelector('.chat-title')?.textContent.includes('Core 已连接')", "回到主会话");
	});

	await step("真实浏览器流式发送与消息呈现", async () => {
		await send("浏览器流式验收");
		await settled(chat.id);
		await waitFor("document.querySelectorAll('.assistant-message').length > 0", "回复呈现");
		assert(packets.some((packet) => packet.event?.assistantMessageEvent?.type === "text_delta"));
	});
	await step("发送失败保留草稿并可重试", async () => {
		await cdp.send("Network.setBlockedURLs", { urls: [`${host.url}/api/sessions/${chat.id}/turns`] });
		await fill('textarea[aria-label="发送消息"]', "失败后保留这条草稿");
		await click('.composer button[type="submit"]');
		await waitFor("document.querySelector('.banner.error')", "发送错误提示");
		assert.equal(await evaluate("document.querySelector('textarea').value"), "失败后保留这条草稿");
		await cdp.send("Network.setBlockedURLs", { urls: [] });
		await click('.composer button[type="submit"]');
		await waitFor("document.querySelector('.running-indicator')", "失败后重新发送");
		await settled(chat.id);
		assert.equal(await evaluate("document.querySelector('textarea').value"), "");
	});
	await step("图片选择、预览和发送", async () => {
		const image = join(directory, "browser-image.png");
		await writeFile(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/K1sAAAAASUVORK5CYII=", "base64"));
		const { root } = await cdp.send("DOM.getDocument");
		const { nodeId } = await cdp.send("DOM.querySelector", { nodeId: root.nodeId, selector: '.composer input[type="file"]' });
		await cdp.send("DOM.setFileInputFiles", { nodeId, files: [image] });
		await waitFor("document.querySelector('.attachment-list img')", "图片预览");
		await send("图片发送验收");
		await settled(chat.id);
		await waitFor("document.querySelector('.user-message img')", "历史图片呈现");
	});
	await step("工具拒绝和失败卡片", async () => {
		await send('调用工具 bash {"command":"printf browser-denied"}');
		await waitFor("document.querySelector('dialog.confirm-dialog[open]')", "命令确认");
		await clickText("拒绝");
		await settled(chat.id);
		assert(await evaluate("document.querySelectorAll('.tool-card.is-error').length > 0"));
	});
	await step("工具批准和输出卡片", async () => {
		await send('调用工具 bash {"command":"printf browser-approved"}');
		await waitFor("document.querySelector('dialog.confirm-dialog[open]')", "批准命令");
		await clickText("确认并继续");
		await settled(chat.id);
		await waitFor("Array.from(document.querySelectorAll('.tool-card')).some(node => node.textContent.includes('browser-approved') && node.textContent.includes('已完成'))", "工具结果");
	});
	await step("执行停止与工具清理", async () => {
		await send('调用工具 bash {"command":"sleep 20","yieldMs":30000}');
		await waitFor("document.querySelector('dialog.confirm-dialog[open]')", "批准长命令");
		await clickText("确认并继续");
		await waitFor("!document.querySelector('dialog.confirm-dialog[open]') && document.querySelector('.send.stop')", "运行可停止");
		await click('[aria-label="停止执行"]');
		await settled(chat.id, "cancelled");
	});
	await step("确认弹窗内直接停止执行", async () => {
		await send('调用工具 bash {"command":"printf browser-stop-confirmation"}');
		await waitFor("document.querySelector('dialog.confirm-dialog[open]')", "待确认执行");
		await clickText("停止本次执行", "document.querySelector('dialog.confirm-dialog')");
		const current = await settled(chat.id, "cancelled");
		assert.equal(current.interactions.length, 0);
		await waitFor("!document.querySelector('dialog.confirm-dialog')", "确认弹窗关闭");
	});
	await step("运行中追加要求并进入同一回合", async () => {
		await send('调用工具 bash {"command":"sleep 2","yieldMs":30000}');
		await waitFor("document.querySelector('dialog.confirm-dialog[open]')", "批准引导执行测试");
		await clickText("确认并继续");
		await waitFor("!document.querySelector('dialog.confirm-dialog') && document.querySelector('[aria-label=追加要求]')", "可追加要求");
		await fill('textarea[aria-label="发送消息"]', "运行中追加的要求");
		await click('.composer button[type="submit"]');
		const current = await settled(chat.id);
		assert(current.messages.some((message) => message.role === "user" && (typeof message.content === "string" ? message.content.includes("运行中追加的要求") : message.content.some((part) => part.type === "text" && part.text.includes("运行中追加的要求")))));
	});
	await step("重试创建独立分支并恢复输入", async () => {
		const original = await api(`/sessions/${chat.id}`);
		await clickText("重试 / 编辑上一条（新分支）");
		await waitFor("document.querySelector('textarea')?.value.includes('运行中追加的要求')", "分支恢复原输入");
		const forkId = await evaluate("localStorage.getItem('pie.web.session')");
		assert.notEqual(forkId, chat.id);
		await send("分支重试验收");
		await settled(forkId);
		assert.equal((await api(`/sessions/${chat.id}`)).messages.length, original.messages.length);
		await evaluate("Array.from(document.querySelectorAll('.session-row')).find(node => node.querySelector('strong')?.textContent === '浏览器主会话').click()");
		await waitFor(`localStorage.getItem('pie.web.session') === ${JSON.stringify(chat.id)} && document.querySelector('.chat-title')?.textContent.includes('Core 已连接')`, "恢复原会话");
	});
	await step("会话切换、历史分页与草稿保留", async () => {
		await fill('textarea[aria-label="发送消息"]', "未发送草稿");
		await evaluate("Array.from(document.querySelectorAll('.session-row')).find(node => node.querySelector('strong')?.textContent === '历史分页验收').click()");
		await waitFor("document.querySelectorAll('.message').length === 50 && document.querySelector('.history-button')", "有界首屏历史");
		await click(".history-button");
		await waitFor("document.querySelectorAll('.message').length === 64 && !document.querySelector('.history-button')", "更早历史");
		await evaluate("Array.from(document.querySelectorAll('.session-row')).find(node => node.querySelector('strong')?.textContent === '浏览器主会话').click()");
		await waitFor("document.querySelector('textarea')?.value === '未发送草稿'", "草稿恢复");
		await fill('textarea[aria-label="发送消息"]', "");
	});
	await step("标题、归档恢复与会话搜索", async () => {
		await click('[aria-label="打开会话详情"]');
		await fill('input[name="title"]', "验收重命名会话");
		await clickText("保存标题");
		await waitFor("document.querySelector('.chat-title strong')?.textContent === '验收重命名会话'", "标题更新");
		await clickText("归档会话");
		await waitFor("!Array.from(document.querySelectorAll('.session-row strong')).some(node => node.textContent === '验收重命名会话')", "最近会话隐藏归档");
		await click('[aria-label="查看归档"]');
		await waitFor("Array.from(document.querySelectorAll('.session-row strong')).some(node => node.textContent === '验收重命名会话')", "归档列表");
		await clickText("取消归档");
		await click('[aria-label="返回最近会话"]');
		await fill("#session-search", "不存在的会话");
		await waitFor("document.querySelector('.empty-list')?.textContent.includes('没有匹配')", "搜索空态");
		await fill("#session-search", "验收重命名");
		await waitFor("document.querySelectorAll('.session-row').length === 1", "搜索命中");
		await fill("#session-search", "");
		await clickText("查看会话分支");
		await waitFor("document.querySelector('.fork-message-list button')", "会话树加载");
		await click('[aria-label="关闭会话树"]');
		await click(".details-panel header button");
	});
	await step("模型、助手与插件设置可操作", async () => {
		await clickText("设置");
		await waitFor("document.querySelector('#settings-title') && !document.querySelector('dialog fieldset')?.disabled", "模型配置加载");
		await fill('input[placeholder="例如：my-provider"]', "browser-local");
		await fill('input[placeholder="输入提供商名称"]', "浏览器本地配置");
		await fill('dialog input[type="url"]', "http://127.0.0.1:9/v1");
		await fill("#new-model", "browser-faux-model");
		await clickText("添加", "document.querySelector('dialog')");
		await clickText("保存", "document.querySelector('dialog')");
		await waitFor("document.querySelector('.settings-success')", "模型配置保存");
		assert((await api("/providers")).providers.some((provider) => provider.id === "browser-local" && provider.models.some((model) => model.id === "browser-faux-model")));
		await clickText("关闭", "document.querySelector('dialog')");
		await click('[aria-label="编辑助手"]');
		await waitFor("document.querySelector('#assistant-settings-title') && !document.querySelector('dialog fieldset')?.disabled", "助手配置加载");
		await fill("dialog fieldset input:not([type=checkbox])", "浏览器助手已保存");
		await clickText("保存助手", "document.querySelector('dialog')");
		await waitFor("!document.querySelector('dialog')", "助手配置保存");
		assert((await api("/assistants")).assistants.some((candidate) => candidate.id === assistant.id && candidate.name === "浏览器助手已保存"));
		await clickText("插件");
		await waitFor("document.querySelector('#plugin-settings-title') && !document.querySelector('dialog fieldset')?.disabled", "插件配置加载");
		assert(await evaluate("document.querySelector('dialog button[type=submit]').disabled"));
		await fill("dialog input", fileURLToPath(new URL("../../../examples/plugins/hello-skill", import.meta.url)));
		await clickText("导入插件", "document.querySelector('dialog')");
		await waitFor("document.querySelector('dialog h3')?.textContent === '本地插件示例'", "插件导入");
		assert((await api("/plugins")).plugins.some((plugin) => plugin.id === "hello-skill"));
		await clickText("卸载", "document.querySelector('dialog')");
		await waitFor("!document.querySelector('dialog h3')", "插件卸载");
		assert.equal((await api("/plugins")).plugins.length, 0);
		await clickText("关闭", "document.querySelector('dialog')");
	});
	await step("网络断开后 SSE 恢复并继续发送", async () => {
		await cdp.send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
		await waitFor("document.querySelector('.chat-title')?.textContent.includes('正在重连') || document.querySelector('.chat-title')?.textContent.includes('Core 离线')", "离线状态");
		await fill('textarea[aria-label="发送消息"]', "断线保留草稿");
		await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
		await waitFor("document.querySelector('.chat-title')?.textContent.includes('Core 已连接')", "SSE 重连", 20000);
		assert.equal(await evaluate("document.querySelector('textarea').value"), "断线保留草稿");
		await send("重连后继续发送");
		await settled(chat.id);
	});
	await step("同会话选择图片节点后重连并重发", async () => {
		await click('[aria-label="打开会话详情"]');
		await clickText("查看会话分支");
		await waitFor("document.querySelector('.fork-message-list button')", "可选择历史节点");
		await evaluate("Array.from(document.querySelectorAll('.fork-message-list button')).find(node => node.querySelector('small')?.textContent.includes('用户') && node.querySelector('span')?.textContent.includes('图片发送验收')).click()");
		await waitFor("document.querySelector('textarea')?.value.includes('图片发送验收') && document.querySelector('.attachment-list img') && document.querySelector('.chat-title')?.textContent.includes('Core 已连接')", "图片节点恢复草稿与连接");
		assert.equal(await evaluate("localStorage.getItem('pie.web.session')"), chat.id);
		await send("树节点图片重发验收");
		await settled(chat.id);
		await waitFor("document.querySelector('.user-message img')", "分支重发图片呈现");
		await clickText("查看会话分支");
		await waitFor("Array.from(document.querySelectorAll('.fork-message-list button')).some(node => node.querySelector('small')?.textContent.includes('其他分支') && node.querySelector('span')?.textContent.includes('图片发送验收'))", "原图片节点保留在其他分支");
		await evaluate("Array.from(document.querySelectorAll('.fork-message-list button')).find(node => node.querySelector('small')?.textContent.includes('其他分支') && node.querySelector('span')?.textContent.includes('图片发送验收')).click()");
		await waitFor("document.querySelector('textarea')?.value.includes('图片发送验收') && document.querySelector('.attachment-list img') && document.querySelector('.chat-title')?.textContent.includes('Core 已连接')", "其他分支图片节点恢复附件");
		await send("其他分支图片重发验收");
		await settled(chat.id);
		await waitFor("document.querySelector('.user-message img')", "其他分支图片重发呈现");
		await click(".details-panel header button");
	});
	await screenshot("desktop");
	await step("窄屏导航、布局与输入", async () => {
		await cdp.send("Emulation.setDeviceMetricsOverride", { width: 420, height: 780, deviceScaleFactor: 1, mobile: false });
		await click('[aria-label="打开导航"]');
		await waitFor("document.querySelector('.sidebar').getBoundingClientRect().left >= -1", "侧栏展开");
		await click('[aria-label="关闭导航"]');
		await waitFor("!document.querySelector('.show-sidebar') && document.querySelector('.sidebar').getBoundingClientRect().right <= 1", "侧栏收起");
		assert(await evaluate("document.documentElement.scrollWidth <= innerWidth"), "窄屏应无横向页面溢出");
		assert(await evaluate("document.querySelector('.composer').getBoundingClientRect().bottom <= innerHeight"));
		await screenshot("narrow");
	});
	await step("窄屏键盘导航与焦点隔离", async () => {
		await waitFor("document.querySelector('.sidebar').inert", "隐藏侧栏不可进入焦点");
		await click('[aria-label="打开导航"]');
		await waitFor("document.activeElement?.id === 'session-search' && !document.querySelector('.sidebar').inert", "打开侧栏聚焦搜索");
		await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
		await waitFor("!document.querySelector('.show-sidebar') && document.querySelector('.sidebar').inert && document.activeElement?.getAttribute('aria-label') === '打开导航'", "Escape关闭并归还焦点");
	});
	await step("小窗口与横向缩放的输入区边界", async () => {
		for (const [width, height] of [[320, 480], [900, 500]]) {
			await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
			await waitFor(`innerWidth === ${width} && innerHeight === ${height}`, "窗口尺寸切换");
			const geometry = await evaluate("({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, composerTop: document.querySelector('.composer').getBoundingClientRect().top, composerBottom: document.querySelector('.composer').getBoundingClientRect().bottom, headerBottom: document.querySelector('.chat-header').getBoundingClientRect().bottom })");
			assert(geometry.scrollWidth <= width, `${width}×${height} 水平溢出：${JSON.stringify(geometry)}`);
			assert(geometry.composerBottom <= height && geometry.composerTop >= geometry.headerBottom, `${width}×${height} 输入区超出视窗：${JSON.stringify(geometry)}`);
			await screenshot(`window-${width}x${height}`);
		}
	});
	await step("刷新后会话与历史恢复", async () => {
		const timeOrigin = await evaluate("performance.timeOrigin");
		await cdp.send("Page.reload");
		await waitFor(`performance.timeOrigin !== ${timeOrigin}`, "页面重新导航");
		await waitFor("document.querySelector('.chat-title strong')?.textContent === '验收重命名会话' && document.querySelector('.chat-title')?.textContent.includes('Core 已连接')", "刷新恢复");
		await waitFor("document.querySelectorAll('.message').length > 0", "刷新后历史呈现");
	});
	assert.deepEqual(errors, [], "浏览器不应出现运行时异常或控制台错误");
} catch (error) {
	process.exitCode = 1;
	errors.push(error instanceof Error ? error.stack : String(error));
	console.error(error);
	if (cdp && session) {
		await screenshot("failure").catch(() => {});
		const body = await evaluate("document.body.innerText").catch(() => "");
		await writeFile(join(artifacts, "failure.txt"), body);
	}
} finally {
	await writeFile(join(artifacts, "results.json"), JSON.stringify({ results, errors, ssePackets: packets.length }, null, 2));
	await writeFile(join(artifacts, "chrome.log"), chromeLog);
	await writeFile(join(artifacts, "network.json"), JSON.stringify(network, null, 2));
	if (cdp) {
		await cdp.send("Browser.close", {}, undefined).catch(() => {});
		cdp.socket.close();
	}
	if (chrome && chrome.exitCode === null) {
		chrome.kill("SIGTERM");
		await Promise.race([once(chrome, "exit"), new Promise((resolve) => setTimeout(resolve, 3000))]);
		if (chrome.exitCode === null) chrome.kill("SIGKILL");
	}
	await host?.close();
	await rm(profile, { recursive: true, force: true });
	await rm(directory, { recursive: true, force: true });
	console.log(`浏览器验收产物：${artifacts}`);
}
