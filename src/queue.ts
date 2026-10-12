import type { CardStore, LiveCard } from "./store";

/** Graded cards falling due within this window come back in the same session. */
export const LEARN_AHEAD_MS = 20 * 60_000;

export interface CardFilter {
	/** Deck path; includes subdecks. */
	deck?: string;
	/** Restrict to one note. */
	path?: string;
}

export function inDeck(deck: string, prefix: string): boolean {
	return deck === prefix || deck.startsWith(prefix + "/");
}

export function matches(c: LiveCard, f: CardFilter): boolean {
	if (f.path !== undefined && c.path !== f.path) return false;
	if (f.deck !== undefined && !inDeck(c.deck, f.deck)) return false;
	return true;
}

function byNoteOrder(a: LiveCard, b: LiveCard): number {
	return a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1;
}

/** New cards allowed today, respecting each card's own deck limit. In note order. */
function newCardsToday(cards: LiveCard[], store: CardStore, limit: number, today: string): LiveCard[] {
	const left = new Map<string, number>();
	const out: LiveCard[] = [];
	for (const c of cards.filter((c) => store.isNew(c.id)).sort(byNoteOrder)) {
		const n = left.get(c.deck) ?? Math.max(0, limit - store.newCountToday(c.deck, today));
		if (n <= 0) continue;
		left.set(c.deck, n - 1);
		out.push(c);
	}
	return out;
}

/** Due cards (oldest first), then today's new cards. */
export function buildReviewQueue(
	store: CardStore,
	filter: CardFilter,
	now: Date,
	newLimit: number,
	today: string,
): string[] {
	const cards = [...store.live.values()].filter((c) => matches(c, filter));
	const due = cards
		.filter((c) => {
			const d = store.due(c.id);
			return d !== null && d <= now;
		})
		.sort((a, b) => store.due(a.id)!.getTime() - store.due(b.id)!.getTime());
	const fresh = newCardsToday(cards, store, newLimit, today);
	return [...due, ...fresh].map((c) => c.id);
}

/** Every matching card, shuffled, regardless of schedule. */
export function buildCramQueue(store: CardStore, filter: CardFilter, rng = Math.random): string[] {
	const ids = [...store.live.values()].filter((c) => matches(c, filter)).map((c) => c.id);
	for (let i = ids.length - 1; i > 0; i--) {
		const j = Math.floor(rng() * (i + 1));
		[ids[i], ids[j]] = [ids[j], ids[i]];
	}
	return ids;
}

export interface DeckNode {
	name: string;
	/** Full deck path, "" for the root. */
	path: string;
	due: number;
	new: number;
	total: number;
	children: DeckNode[];
}

/** Deck tree with due / new-today / total counts, summed up through parents. */
export function deckTree(store: CardStore, now: Date, newLimit: number, today: string): DeckNode {
	const root: DeckNode = { name: "All decks", path: "", due: 0, new: 0, total: 0, children: [] };
	const nodeFor = (deck: string): DeckNode[] => {
		const chain = [root];
		let node = root;
		const parts = deck.split("/");
		for (let i = 0; i < parts.length; i++) {
			const path = parts.slice(0, i + 1).join("/");
			let child = node.children.find((c) => c.path === path);
			if (!child) {
				child = { name: parts[i], path, due: 0, new: 0, total: 0, children: [] };
				node.children.push(child);
				node.children.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
			}
			node = child;
			chain.push(node);
		}
		return chain;
	};

	const cards = [...store.live.values()];
	const freshIds = new Set(newCardsToday(cards, store, newLimit, today).map((c) => c.id));
	for (const c of cards) {
		const d = store.due(c.id);
		for (const n of nodeFor(c.deck)) {
			n.total++;
			if (d !== null && d <= now) n.due++;
			if (freshIds.has(c.id)) n.new++;
		}
	}
	return root;
}

/** Card order for one review sitting, including short-term relearning and undo. */
export class Session {
	private queue: string[];
	private learning: { id: string; due: number }[] = [];

	constructor(ids: string[]) {
		this.queue = [...ids];
	}

	get remaining(): number {
		return this.queue.length + this.learning.length;
	}

	next(now: Date): string | null {
		this.learning.sort((a, b) => a.due - b.due);
		if (this.learning.length && this.learning[0].due <= now.getTime()) return this.learning.shift()!.id;
		if (this.queue.length) return this.queue.shift()!;
		// Nothing else left: learn ahead rather than ending with cards a few minutes away.
		if (this.learning.length) return this.learning.shift()!.id;
		return null;
	}

	/** Brings a graded card back this session if it is due again soon. */
	requeue(id: string, due: Date, now: Date): void {
		if (due.getTime() - now.getTime() <= LEARN_AHEAD_MS) this.learning.push({ id, due: due.getTime() });
	}

	/** Cram mode: missed cards go to the back. */
	pushBack(id: string): void {
		this.queue.push(id);
	}

	/** Puts a card back at the front, e.g. on undo or when leaving it unanswered. */
	putBack(id: string): void {
		this.learning = this.learning.filter((l) => l.id !== id);
		this.queue = this.queue.filter((q) => q !== id);
		this.queue.unshift(id);
	}

	remove(id: string): void {
		this.learning = this.learning.filter((l) => l.id !== id);
		this.queue = this.queue.filter((q) => q !== id);
	}
}
