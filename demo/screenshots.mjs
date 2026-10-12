// Drives a throwaway Obsidian instance on the demo vault over the DevTools protocol and saves screenshots.
// Usage (from the repo root, on a headless display):
//   npm run build && npm run demo:seed && npm run demo:deploy
//   Xvfb :97 -screen 0 1600x1000x24 &  DISPLAY=:97 node demo/screenshots.mjs [outDir]
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const VAULT = resolve(import.meta.dirname, "vault");
const OUT = resolve(process.argv[2] ?? "screenshots-raw");
const PORT = 9333;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// Separate profile so the user's own Obsidian config and vault list are untouched.
const profile = mkdtempSync(join(tmpdir(), "retain-obsidian-"));
writeFileSync(
	join(profile, "obsidian.json"),
	JSON.stringify({ vaults: { demo: { path: VAULT, ts: Date.now(), open: true } } }),
);
const obsidian = spawn(
	"obsidian",
	[`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--ozone-platform=x11", "--no-sandbox"],
	{ stdio: "ignore", env: obsidianEnv() },
);

// Force X11 (the virtual display) and drop library overrides that can clash with Electron's own.
function obsidianEnv() {
	const env = { ...process.env, WAYLAND_DISPLAY: "" };
	delete env.LD_LIBRARY_PATH;
	return env;
}

let ws;
let nextId = 1;
const pending = new Map();
const errors = [];

async function connect() {
	for (let i = 0; i < 60; i++) {
		try {
			const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
			const page = targets.find((t) => t.type === "page" && t.url.includes("index.html"));
			if (page) {
				ws = new WebSocket(page.webSocketDebuggerUrl);
				await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
				ws.onmessage = (m) => {
					const msg = JSON.parse(m.data);
					if (msg.id && pending.has(msg.id)) {
						pending.get(msg.id)(msg);
						pending.delete(msg.id);
					} else if (msg.method === "Runtime.exceptionThrown") {
						errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
					} else if (msg.method === "Runtime.consoleAPICalled" && msg.params.type === "error") {
						errors.push(msg.params.args.map((a) => a.value ?? a.description).join(" "));
					}
				};
				await send("Runtime.enable");
				await send("Page.enable");
				return;
			}
		} catch {}
		await sleep(500);
	}
	throw new Error("Obsidian did not start");
}

function send(method, params = {}) {
	const id = nextId++;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((r) => pending.set(id, r));
}

async function js(expression) {
	const res = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
	if (res.result?.exceptionDetails) throw new Error(`${expression}\n${JSON.stringify(res.result.exceptionDetails)}`);
	return res.result?.result?.value;
}

async function waitFor(expression, timeout = 15000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (await js(`!!(${expression})`).catch(() => false)) return;
		await sleep(200);
	}
	throw new Error(`timeout waiting for ${expression}`);
}

/** Attaches to another window (e.g. Obsidian 1.13+ opens Settings as a pop-out). */
async function attachTo(match, timeout = 10000) {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
		const t = targets.find((t) => t.type === "page" && match(t));
		if (t) {
			const sock = new WebSocket(t.webSocketDebuggerUrl);
			await new Promise((r, j) => ((sock.onopen = r), (sock.onerror = j)));
			let n = 0;
			const waiting = new Map();
			sock.onmessage = (m) => {
				const msg = JSON.parse(m.data);
				if (msg.id && waiting.has(msg.id)) waiting.get(msg.id)(msg);
			};
			const call = (method, params = {}) =>
				new Promise((r) => {
					waiting.set(++n, r);
					sock.send(JSON.stringify({ id: n, method, params }));
				});
			const run = async (expression) =>
				(await call("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
			return {
				js: run,
				async waitFor(expression, ms = 10000) {
					const stop = Date.now() + ms;
					while (Date.now() < stop) {
						if (await run(`!!(${expression})`)) return;
						await sleep(200);
					}
					throw new Error(`timeout waiting for ${expression} in pop-out`);
				},
				async shot(name) {
					await sleep(500);
					const { result } = await call("Page.captureScreenshot", { format: "png" });
					writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, "base64"));
					console.log(`  ${name}.png`);
				},
				close: () => sock.close(),
			};
		}
		await sleep(300);
	}
	throw new Error("pop-out window not found");
}

async function viewport(width, height, scale, mobile = false) {
	await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile });
	await sleep(300);
}

async function shot(name) {
	await sleep(500);
	const { result } = await send("Page.captureScreenshot", { format: "png" });
	writeFileSync(join(OUT, `${name}.png`), Buffer.from(result.data, "base64"));
	console.log(`  ${name}.png`);
}

/** Facts about the open Retain modal that should always hold. */
async function check(label) {
	await sleep(800); // let open animations (phone modals slide up) finish
	const facts = await js(`(() => {
		const modal = document.querySelector('.retain-modal');
		if (!modal) return { modal: false };
		const visible = (el) => !!el.offsetParent || el.getClientRects().length > 0;
		const closes = [...modal.querySelectorAll('[aria-label="Close"], .modal-close-button, .modal-header-button')].filter(visible);
		const r = modal.getBoundingClientRect();
		const overflowX = [...modal.querySelectorAll('*')].filter((el) => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'visible' && getComputedStyle(el).overflowX !== 'hidden').map((el) => el.className);
		return { modal: true, closeButtons: closes.length, inViewport: r.left >= -2 && r.top >= -2 && r.right <= innerWidth + 2 && r.bottom <= innerHeight + 2, rect: [r.left, r.top, r.right, r.bottom, innerWidth, innerHeight].map(Math.round), overflowX };
	})()`);
	const problems = [];
	if (!facts.modal) problems.push("modal missing");
	else {
		if (facts.closeButtons !== 1) problems.push(`${facts.closeButtons} close buttons`);
		if (!facts.inViewport) problems.push(`modal outside viewport ${facts.rect}`);
		if (facts.overflowX.length) problems.push(`horizontal overflow: ${facts.overflowX.join(", ")}`);
	}
	console.log(`  check ${label}: ${problems.length ? "FAIL " + problems.join("; ") : "ok"}`);
	return problems.length === 0;
}

const click = (selector, text) =>
	js(`(() => {
		const els = [...document.querySelectorAll(${JSON.stringify(selector)})];
		const el = ${text === undefined ? "els[0]" : `els.find((e) => e.textContent.trim().includes(${JSON.stringify(text)}))`};
		if (!el) throw new Error('no element ${selector} ${text ?? ""}');
		el.click();
	})()`);

const key = async (k) => {
	const code = k === " " ? "Space" : k.length === 1 ? `Key${k.toUpperCase()}` : k;
	await send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, text: k.length === 1 ? k : undefined });
	await send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code });
	await sleep(250);
};

async function boot() {
	await connect();
	await waitFor("window.app && app.workspace && app.workspace.layoutReady");
	// Close the "trust this vault" prompt if Obsidian shows it.
	await js(`document.querySelectorAll('.modal-container').forEach((m) => m.remove())`);
	if (!(await js("!!app.plugins.plugins.retain"))) {
		await js("app.plugins.setEnable(true)");
		await js("app.plugins.loadManifests()");
		await js("app.plugins.enablePluginAndSave('retain')");
	}
	await waitFor("app.plugins.plugins.retain && app.plugins.plugins.retain.store.live.size > 0");
	await js("document.body.addClass('is-screenshot')");
}

const openNote = (path) => js(`app.workspace.getLeaf(false).openFile(app.vault.getAbstractFileByPath(${JSON.stringify(path)}))`);
const closeModals = () => js("document.querySelectorAll('.modal-container').forEach((m) => m.remove())");
const theme = async (t) => {
	await js(`app.changeTheme(${JSON.stringify(t)})`);
	await sleep(400);
};

let ok = true;
try {
	await boot();
	await viewport(1280, 820, 2);
	await openNote("Science/Physics.md");

	for (const t of ["obsidian", "moonstone"]) {
		const suffix = t === "obsidian" ? "dark" : "light";
		console.log(`theme ${suffix}`);
		await theme(t);

		await closeModals();
		await js("app.commands.executeCommandById('retain:review')");
		await waitFor("document.querySelector('.retain-deck-row:not(.retain-deck-head)')");
		ok = (await check("decks")) && ok;
		const misaligned = await js(`(() => {
			const center = (el) => { const r = el.getBoundingClientRect(); return (r.left + r.right) / 2; };
			const head = [...document.querySelectorAll('.retain-deck-head .retain-count')].map(center);
			const off = [];
			for (const row of document.querySelectorAll('.retain-deck-row:not(.retain-deck-head)')) {
				[...row.querySelectorAll('.retain-count')].forEach((c, i) => {
					const d = Math.abs(center(c) - head[i]);
					if (d > 2) off.push(Math.round(d));
				});
			}
			return off;
		})()`);
		console.log(`  columns aligned: ${misaligned.length ? "FAIL offsets " + misaligned.join(",") : "ok"}`);
		ok = ok && misaligned.length === 0;
		await shot(`decks-${suffix}`);

		await closeModals();
		await js("app.commands.executeCommandById('retain:review-current-note')");
		await waitFor("document.querySelector('.retain-question')");
		ok = (await check("question")) && ok;
		await shot(`question-${suffix}`);
		await key(" ");
		await waitFor("document.querySelector('.retain-answer')");
		ok = (await check("answer")) && ok;
		await shot(`answer-${suffix}`);

		await closeModals();
		await js("app.commands.executeCommandById('retain:stats')");
		await waitFor("document.querySelector('.retain-bars')");
		ok = (await check("stats")) && ok;
		await shot(`stats-${suffix}`);
		await closeModals();
	}

	console.log("settings");
	await closeModals();
	await theme("obsidian");
	await js("app.setting.open(); app.setting.openTabById('retain')");
	const settingsWin = await attachTo((t) => !t.url.includes("index.html"));
	await settingsWin.waitFor("document.querySelector('.vertical-tab-content .setting-item-name')");
	const names = await settingsWin.js("[...document.querySelectorAll('.vertical-tab-content .setting-item-name')].map((e) => e.textContent)");
	const expected = ["Flashcard tag", "Separator", "New cards per day", "Target retention", "Maximum interval", "Fuzz intervals", "Show interval previews"];
	const settingsOk = expected.every((n) => names.filter((x) => x === n).length === 1);
	console.log(`  settings rendered once each: ${settingsOk ? "ok" : "FAIL " + JSON.stringify(names)}`);
	ok = ok && settingsOk;
	await settingsWin.shot("settings-dark");
	settingsWin.close();
	await js("app.setting.close()");

	console.log("interactions (dark)");
	await theme("obsidian");
	await js("app.commands.executeCommandById('retain:review-current-note')");
	await waitFor("document.querySelector('.retain-question')");
	const first = await js("document.querySelector('.retain-question').textContent");
	await key(" ");
	await key("3");
	const second = await js("document.querySelector('.retain-question')?.textContent");
	await key("u");
	const afterUndo = await js("document.querySelector('.retain-question').textContent");
	console.log(`  undo returns to first card: ${afterUndo === first && second !== first ? "ok" : "FAIL"}`);
	ok = ok && afterUndo === first;

	await key("e");
	await waitFor("document.querySelector('.retain-editor textarea')");
	ok = (await check("editor")) && ok;
	await shot("edit-dark");
	const editOk = await js(`(async () => {
		const p = app.plugins.plugins.retain;
		const wasNew = p.store.isNew([...p.store.live.values()].find((c) => c.question === document.querySelector('.retain-editor textarea').value).id);
		const q = document.querySelector('.retain-editor textarea');
		q.value = q.value + ' (edited)';
		[...document.querySelectorAll('.retain-actions button')].find((b) => b.textContent.includes('Save')).click();
		await new Promise((r) => setTimeout(r, 1500));
		const card = [...p.store.live.values()].find((c) => c.question.endsWith('(edited)'));
		const file = app.vault.getAbstractFileByPath(card.path);
		const onDisk = (await app.vault.read(file)).includes('(edited)');
		const kept = p.store.isNew(card.id) === wasNew;
		const shown = document.querySelector('.retain-question')?.textContent.includes('(edited)');
		await app.vault.process(file, (t) => t.replace(' (edited)', ''));
		return { onDisk, kept, shown, wasNew };
	})()`);
	console.log(`  edit saves to note and keeps history: ${JSON.stringify(editOk)}`);
	ok = ok && editOk.onDisk && editOk.kept && editOk.shown;
	await sleep(1500);

	// Cram through the Danish deck to reach the "done" screen; cram doesn't touch data.json.
	await closeModals();
	await js("app.commands.executeCommandById('retain:review')");
	await waitFor("document.querySelector('.retain-deck-row')");
	await js(`(() => { const s = document.querySelector('.retain-header select'); s.value = 'cram'; s.dispatchEvent(new Event('change')); })()`);
	await click(".retain-deck-row", "danish");
	await waitFor("document.querySelector('.retain-badge')");
	await shot("cram-dark");
	for (let i = 0; i < 20 && (await js("!!document.querySelector('.retain-question')")); i++) {
		await key(" ");
		await key("3");
	}
	await waitFor("document.querySelector('.retain-done')");
	ok = (await check("done")) && ok;
	await shot("done-dark");
	await closeModals();

	console.log("mobile");
	await js("app.emulateMobile(true)").catch(() => {});
	await sleep(1500);
	ws.close();
	await boot();
	await viewport(390, 844, 3, true);
	await theme("obsidian");
	await js("app.commands.executeCommandById('retain:review')");
	await waitFor("document.querySelector('.retain-deck-row:not(.retain-deck-head)')");
	ok = (await check("mobile decks")) && ok;
	await shot("mobile-decks");
	await closeModals();
	await openNote("Science/Physics.md");
	await js("app.commands.executeCommandById('retain:review-current-note')");
	await waitFor("document.querySelector('.retain-question')");
	await click(".retain-actions button");
	await waitFor("document.querySelector('.retain-answer')");
	ok = (await check("mobile answer")) && ok;
	await shot("mobile-answer");
	await js("app.emulateMobile(false)").catch(() => {});
} catch (e) {
	ok = false;
	console.error(e);
	await shot("error").catch(() => {});
	const dom = await js(`[...document.querySelectorAll('.modal-container .modal *')].slice(0, 60).map((e) => e.tagName.toLowerCase() + '.' + [...e.classList].join('.')).join('\\n')`).catch(() => "");
	console.error(dom);
} finally {
	const relevant = errors.filter((e) => /retain/i.test(e));
	console.log(`console errors mentioning retain: ${relevant.length}`);
	for (const e of relevant) console.log(`  ${e}`);
	if (errors.length > relevant.length) console.log(`(other console errors: ${errors.length - relevant.length})`);
	obsidian.kill();
	await sleep(500);
	rmSync(profile, { recursive: true, force: true });
	console.log(ok && relevant.length === 0 ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED");
	process.exit(ok ? 0 : 1);
}
