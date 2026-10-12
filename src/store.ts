import { Card, createEmptyCard, Rating, ReviewLog, State } from "ts-fsrs";
import type { ParsedCard } from "./parser";
import { DEFAULT_SETTINGS, RetainSettings } from "./settings";

/** FSRS card with dates as ISO strings, as kept in data.json. */
export type StoredFsrs = Omit<Card, "due" | "last_review"> & { due: string; last_review?: string };

export interface StoredCard {
	fsrs: StoredFsrs;
	path: string;
	question: string;
	deck: string;
	/** Set when the card disappeared from its note; pruned after ORPHAN_DAYS. */
	orphanedAt?: string;
}

export interface LogEntry {
	id: string;
	rating: Rating;
	/** Card state before this review. */
	state: State;
	review: string;
	due: string;
	scheduledDays: number;
}

export interface RetainData {
	settings: RetainSettings;
	cards: Record<string, StoredCard>;
	log: LogEntry[];
	/** New cards introduced today, per deck. Resets when the local date changes. */
	newToday: { date: string; count: Record<string, number> };
}

/** A card currently present in the vault. */
export interface LiveCard extends ParsedCard {
	id: string;
	path: string;
}

export interface Snapshot {
	id: string;
	stored?: StoredCard;
	logLength: number;
	newToday: RetainData["newToday"];
}

export const ORPHAN_DAYS = 30;
const FUZZY_THRESHOLD = 0.75;
const DAY_MS = 86_400_000;

export function emptyData(): RetainData {
	return { settings: { ...DEFAULT_SETTINGS }, cards: {}, log: [], newToday: { date: "", count: {} } };
}

/** Fills in anything missing from older or hand-edited data.json files. */
export function normalizeData(raw: unknown): RetainData {
	const d = (raw ?? {}) as Partial<RetainData>;
	return {
		settings: { ...DEFAULT_SETTINGS, ...(d.settings ?? {}) },
		cards: d.cards ?? {},
		log: d.log ?? [],
		newToday: d.newToday ?? { date: "", count: {} },
	};
}

export function localDate(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function normalize(q: string): string {
	return q.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Short FNV-1a hash of the normalized question. */
export function hashId(text: string): string {
	let h = 0x811c9dc5;
	const s = normalize(text);
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193);
	}
	return (h >>> 0).toString(36).padStart(7, "0");
}

function bigrams(s: string): Map<string, number> {
	const m = new Map<string, number>();
	const t = normalize(s);
	for (let i = 0; i < t.length - 1; i++) {
		const b = t.slice(i, i + 2);
		m.set(b, (m.get(b) ?? 0) + 1);
	}
	return m;
}

/** Dice coefficient on character bigrams, 0–1. */
export function similarity(a: string, b: string): number {
	if (normalize(a) === normalize(b)) return 1;
	const A = bigrams(a);
	const B = bigrams(b);
	let total = 0;
	let overlap = 0;
	for (const n of A.values()) total += n;
	for (const n of B.values()) total += n;
	for (const [k, n] of A) overlap += Math.min(n, B.get(k) ?? 0);
	return total === 0 ? 0 : (2 * overlap) / total;
}

export function serializeCard(c: Card): StoredFsrs {
	return { ...c, due: c.due.toISOString(), last_review: c.last_review?.toISOString() };
}

export function deserializeCard(s: StoredFsrs): Card {
	// Spread over an empty card so fields missing from older data get defaults.
	return {
		...createEmptyCard(new Date(s.due)),
		...s,
		due: new Date(s.due),
		last_review: s.last_review ? new Date(s.last_review) : undefined,
	};
}

/**
 * Owns data.json state plus the in-memory index of cards present in the vault.
 * Review state is keyed by a hash of the question, so notes never contain metadata.
 */
export class CardStore {
	readonly live = new Map<string, LiveCard>();
	private byFile = new Map<string, string[]>();

	constructor(public data: RetainData) {}

	/** Updates the index for one note and carries review state over edits, moves and renames. */
	reconcileFile(path: string, parsed: ParsedCard[], now = new Date()): void {
		this.clearLive(path);
		const { cards: stored } = this.data;

		const seen = new Map<string, number>();
		const cards: LiveCard[] = parsed.map((p) => {
			const base = hashId(p.question);
			const n = (seen.get(base) ?? 0) + 1;
			seen.set(base, n);
			let id = n > 1 ? `${base}-${n}` : base;
			// Same question in another note: keep both, distinguished by path.
			if (this.live.has(id)) id = `${id}-${hashId(path)}`;
			return { ...p, id, path };
		});
		const ids = new Set(cards.map((c) => c.id));

		const vanished = Object.keys(stored).filter(
			(id) => stored[id].path === path && !ids.has(id) && !this.live.has(id),
		);
		let fresh = cards.filter((c) => !stored[c.id]);

		// A card moved here from another note may have been orphaned there under a different id.
		for (const c of fresh) {
			const orphan = Object.keys(stored).find(
				(id) => stored[id].orphanedAt && !ids.has(id) && normalize(stored[id].question) === normalize(c.question),
			);
			if (orphan) this.moveState(orphan, c.id);
		}
		fresh = fresh.filter((c) => !stored[c.id]);

		// Edited questions: pair vanished cards with new ones by similarity, best matches first.
		const pairs: { from: string; to: string; score: number }[] = [];
		for (const v of vanished) {
			for (const f of fresh) {
				const score = similarity(stored[v].question, f.question);
				if (score >= FUZZY_THRESHOLD) pairs.push({ from: v, to: f.id, score });
			}
		}
		pairs.sort((a, b) => b.score - a.score);
		const usedFrom = new Set<string>();
		const usedTo = new Set<string>();
		for (const p of pairs) {
			if (usedFrom.has(p.from) || usedTo.has(p.to)) continue;
			this.moveState(p.from, p.to);
			usedFrom.add(p.from);
			usedTo.add(p.to);
		}

		for (const v of vanished) {
			if (usedFrom.has(v) || !stored[v]) continue;
			// Moved to a note that was scanned earlier under a suffixed id.
			const moved = [...this.live.values()].find(
				(c) => !stored[c.id] && normalize(c.question) === normalize(stored[v].question),
			);
			if (moved) this.moveState(v, moved.id);
			else stored[v].orphanedAt ??= now.toISOString();
		}

		for (const c of cards) {
			const s = stored[c.id];
			if (s) {
				s.path = path;
				s.question = c.question;
				s.deck = c.deck;
				delete s.orphanedAt;
			}
			this.live.set(c.id, c);
		}
		this.byFile.set(path, cards.map((c) => c.id));
	}

	removeFile(path: string, now = new Date()): void {
		this.clearLive(path);
		for (const s of Object.values(this.data.cards)) {
			if (s.path === path) s.orphanedAt ??= now.toISOString();
		}
	}

	renameFile(oldPath: string, newPath: string): void {
		const ids = this.byFile.get(oldPath);
		if (ids) {
			this.byFile.delete(oldPath);
			this.byFile.set(newPath, ids);
			for (const id of ids) {
				const c = this.live.get(id);
				if (c) c.path = newPath;
			}
		}
		for (const s of Object.values(this.data.cards)) {
			if (s.path === oldPath) s.path = newPath;
		}
	}

	hasFile(path: string): boolean {
		return this.byFile.has(path);
	}

	/** Deletes review state for cards orphaned longer than `days`. Review log entries are kept for stats. */
	pruneOrphans(now = new Date(), days = ORPHAN_DAYS): number {
		let n = 0;
		for (const [id, s] of Object.entries(this.data.cards)) {
			if (s.orphanedAt && now.getTime() - new Date(s.orphanedAt).getTime() > days * DAY_MS) {
				delete this.data.cards[id];
				n++;
			}
		}
		return n;
	}

	/** Moves review state (and its log) from one id to another, e.g. after editing a question. */
	moveState(from: string, to: string): void {
		const s = this.data.cards[from];
		if (!s || from === to) return;
		this.data.cards[to] = s;
		delete this.data.cards[from];
		for (const e of this.data.log) if (e.id === from) e.id = to;
	}

	getFsrs(id: string, now = new Date()): Card {
		const s = this.data.cards[id];
		return s ? deserializeCard(s.fsrs) : createEmptyCard(now);
	}

	isNew(id: string): boolean {
		const s = this.data.cards[id];
		return !s || s.fsrs.state === State.New;
	}

	/** Due date for reviewed cards, null for new ones. */
	due(id: string): Date | null {
		return this.isNew(id) ? null : new Date(this.data.cards[id].fsrs.due);
	}

	applyReview(id: string, card: Card, log: ReviewLog): void {
		const c = this.live.get(id);
		const prev = this.data.cards[id];
		this.data.cards[id] = {
			fsrs: serializeCard(card),
			path: c?.path ?? prev?.path ?? "",
			question: c?.question ?? prev?.question ?? "",
			deck: c?.deck ?? prev?.deck ?? "default",
		};
		this.data.log.push({
			id,
			rating: log.rating,
			state: log.state,
			review: log.review.toISOString(),
			due: log.due.toISOString(),
			scheduledDays: log.scheduled_days,
		});
	}

	newCountToday(deck: string, today: string): number {
		return this.data.newToday.date === today ? (this.data.newToday.count[deck] ?? 0) : 0;
	}

	bumpNew(deck: string, today: string): void {
		if (this.data.newToday.date !== today) this.data.newToday = { date: today, count: {} };
		this.data.newToday.count[deck] = (this.data.newToday.count[deck] ?? 0) + 1;
	}

	snapshot(id: string): Snapshot {
		const s = this.data.cards[id];
		return {
			id,
			stored: s ? structuredClone(s) : undefined,
			logLength: this.data.log.length,
			newToday: structuredClone(this.data.newToday),
		};
	}

	restore(snap: Snapshot): void {
		if (snap.stored) this.data.cards[snap.id] = snap.stored;
		else delete this.data.cards[snap.id];
		this.data.log.length = snap.logLength;
		this.data.newToday = snap.newToday;
	}

	private clearLive(path: string): void {
		for (const id of this.byFile.get(path) ?? []) this.live.delete(id);
		this.byFile.delete(path);
	}
}
