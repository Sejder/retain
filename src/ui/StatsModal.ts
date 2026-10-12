import { App, Modal } from "obsidian";
import { Rating, State } from "ts-fsrs";
import type RetainPlugin from "../main";
import { localDate } from "../store";
import { header, iconButton, setupModal } from "./RetainModal";

const DAYS = 30;
const DAY_MS = 86_400_000;

function addDays(d: Date, n: number): Date {
	const out = new Date(d);
	out.setDate(out.getDate() + n);
	return out;
}

export class StatsModal extends Modal {
	constructor(
		app: App,
		private plugin: RetainPlugin,
	) {
		super(app);
	}

	onOpen(): void {
		setupModal(this, "retain-stats");
		const { contentEl } = this;
		contentEl.empty();
		const h = header(contentEl, "bar-chart-2", "Stats");
		iconButton(h.right, "x", "Close", () => this.close());

		const { store, db } = this.plugin;
		const now = new Date();
		const today = localDate(now);
		const body = contentEl.createDiv("retain-stats-body");

		// Cards by state
		const states = { New: 0, Learning: 0, Review: 0, Relearning: 0 };
		for (const id of store.live.keys()) {
			const s = db.cards[id]?.fsrs.state ?? State.New;
			states[State[s] as keyof typeof states]++;
		}
		const since = now.getTime() - DAYS * DAY_MS;
		const recent = db.log.filter((e) => new Date(e.review).getTime() >= since);
		const matured = recent.filter((e) => e.state === State.Review);
		const retention = matured.length
			? `${Math.round((100 * matured.filter((e) => e.rating !== Rating.Again).length) / matured.length)}%`
			: "–";

		const tiles = body.createDiv("retain-tiles");
		const tile = (label: string, value: string | number) => {
			const t = tiles.createDiv("retain-tile");
			t.createDiv({ cls: "retain-tile-value", text: String(value) });
			t.createDiv({ cls: "retain-tile-label", text: label });
		};
		tile("Cards", store.live.size);
		tile("Reviews today", db.log.filter((e) => localDate(new Date(e.review)) === today).length);
		tile("Retention", retention);
		tile("New", states.New);
		tile("Learning", states.Learning + states.Relearning);
		tile("Review", states.Review);

		// Reviews per day, last 30 days
		const perDay = new Map<string, number>();
		for (const e of recent) {
			const k = localDate(new Date(e.review));
			perDay.set(k, (perDay.get(k) ?? 0) + 1);
		}
		const past = Array.from({ length: DAYS }, (_, i) => {
			const d = localDate(addDays(now, i - DAYS + 1));
			return { label: d, value: perDay.get(d) ?? 0 };
		});
		this.bars(body, `Reviews, last ${DAYS} days`, past, "Today");

		// Due forecast, next 30 days (overdue counts as today)
		const forecast = Array.from({ length: DAYS }, (_, i) => ({ label: localDate(addDays(now, i)), value: 0 }));
		const index = new Map(forecast.map((f, i) => [f.label, i]));
		for (const id of store.live.keys()) {
			const due = store.due(id);
			if (!due) continue;
			const i = due <= now ? 0 : index.get(localDate(due));
			if (i !== undefined) forecast[i].value++;
		}
		this.bars(body, `Due, next ${DAYS} days`, forecast, "In 30 days", true);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private bars(parent: HTMLElement, title: string, data: { label: string; value: number }[], endLabel: string, future = false): void {
		const section = parent.createDiv("retain-chart");
		const total = data.reduce((s, d) => s + d.value, 0);
		section.createDiv({ cls: "retain-chart-title", text: `${title} · ${total}` });
		const max = Math.max(1, ...data.map((d) => d.value));
		const chart = section.createDiv("retain-bars");
		for (const d of data) {
			const col = chart.createDiv({ cls: "retain-bar-col", attr: { "aria-label": `${d.label}: ${d.value}` } });
			const bar = col.createDiv("retain-bar");
			bar.setCssProps({ "--retain-bar-h": `${(100 * d.value) / max}%` });
			if (d.value === 0) bar.addClass("is-empty");
		}
		const axis = section.createDiv("retain-axis");
		axis.createSpan({ text: future ? "Today" : `${DAYS} days ago` });
		axis.createSpan({ text: future ? endLabel : "Today" });
	}
}
