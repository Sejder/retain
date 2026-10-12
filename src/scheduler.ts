import { Card, FSRS, fsrs, generatorParameters, Grade, Rating, RecordLogItem } from "ts-fsrs";
import type { RetainSettings } from "./settings";

export const GRADES: Grade[] = [Rating.Again, Rating.Hard, Rating.Good, Rating.Easy];

export function formatInterval(ms: number): string {
	const min = Math.max(1, Math.round(ms / 60_000));
	if (min < 60) return `${min}m`;
	const h = min / 60;
	if (h < 24) return `${Math.round(h)}h`;
	const d = h / 24;
	if (d < 30) return `${Math.round(d)}d`;
	if (d < 365) return `${(d / 30).toFixed(1).replace(/\.0$/, "")}mo`;
	return `${(d / 365).toFixed(1).replace(/\.0$/, "")}y`;
}

export class Scheduler {
	private f!: FSRS;

	constructor(settings: RetainSettings) {
		this.configure(settings);
	}

	configure(s: RetainSettings): void {
		this.f = fsrs(
			generatorParameters({
				request_retention: s.retention,
				maximum_interval: s.maxInterval,
				enable_fuzz: s.fuzz,
			}),
		);
	}

	grade(card: Card, now: Date, rating: Grade): RecordLogItem {
		return this.f.next(card, now, rating);
	}

	/** Next interval for each grade, e.g. { 1: "1m", 2: "6m", 3: "10m", 4: "8d" }. */
	preview(card: Card, now: Date): Record<Grade, string> {
		const r = this.f.repeat(card, now);
		const out = {} as Record<Grade, string>;
		for (const g of GRADES) out[g] = formatInterval(r[g].card.due.getTime() - now.getTime());
		return out;
	}
}
