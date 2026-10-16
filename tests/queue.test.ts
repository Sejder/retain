import { describe, expect, it } from "vitest";
import { fsrs, Rating } from "ts-fsrs";
import type { ParsedCard } from "../src/parser";
import { buildCramQueue, buildReviewQueue, deckTree, LEARN_AHEAD_MS, Session } from "../src/queue";
import { CardStore, emptyData, hashId } from "../src/store";

const NOW = new Date("2026-10-12T10:00:00Z");
const TODAY = "2026-10-12";
const card = (question: string, deck: string, line: number): ParsedCard => ({ question, answer: "a", deck, line, endLine: line });

function setup() {
	const s = new CardStore(emptyData());
	s.reconcileFile("a.md", [card("a1", "ml/w01", 0), card("a2", "ml/w01", 1), card("a3", "ml/w01", 2)]);
	s.reconcileFile("b.md", [card("b1", "ml/w02", 0), card("b2", "ml/w02", 1), card("c1", "bio", 2)]);
	return s;
}

function reviewAt(s: CardStore, q: string, when: Date) {
	const { card: next, log } = fsrs().next(s.getFsrs(hashId(q), when), when, Rating.Good);
	s.applyReview(hashId(q), next, log);
	return next;
}

describe("buildReviewQueue", () => {
	it("returns due cards first, then new cards in note order, limited per deck", () => {
		const s = setup();
		const past = new Date(NOW.getTime() - 30 * 86_400_000);
		reviewAt(s, "a3", past);
		reviewAt(s, "a3", new Date(past.getTime() + 600_000));
		s.bumpNew("ml/w02", TODAY);

		const q = buildReviewQueue(s, { deck: "ml" }, NOW, 1, TODAY);
		// a3 due; one new from w01 (a1); w02 already used its one new card today.
		expect(q).toEqual([hashId("a3"), hashId("a1")]);
	});

	it("filters by deck prefix and by note", () => {
		const s = setup();
		expect(buildReviewQueue(s, { deck: "bio" }, NOW, 20, TODAY)).toEqual([hashId("c1")]);
		expect(buildReviewQueue(s, { deck: "ml/w0" }, NOW, 20, TODAY)).toEqual([]);
		expect(buildReviewQueue(s, { path: "b.md" }, NOW, 20, TODAY)).toHaveLength(3);
	});
});

describe("buildCramQueue", () => {
	it("includes every card regardless of schedule", () => {
		const s = setup();
		reviewAt(s, "a1", NOW);
		expect(new Set(buildCramQueue(s, { deck: "ml" }))).toEqual(
			new Set(["a1", "a2", "a3", "b1", "b2"].map(hashId)),
		);
	});
});

describe("deckTree", () => {
	it("nests decks and sums counts", () => {
		const s = setup();
		const root = deckTree(s, NOW, 2, TODAY);
		expect(root.total).toBe(6);
		expect(root.new).toBe(5); // 2 + 2 + 1
		const ml = root.children.find((c) => c.name === "ml")!;
		expect(ml.children.map((c) => [c.path, c.total, c.new])).toEqual([
			["ml/w01", 3, 2],
			["ml/w02", 2, 2],
		]);
	});
});

describe("Session", () => {
	it("brings soon-due cards back, learning ahead at the end", () => {
		const ses = new Session(["a", "b"]);
		expect(ses.next(NOW)).toBe("a");
		ses.requeue("a", new Date(NOW.getTime() + 60_000), NOW);
		ses.requeue("x", new Date(NOW.getTime() + LEARN_AHEAD_MS + 1), NOW); // too far: dropped
		expect(ses.next(NOW)).toBe("b");
		expect(ses.next(NOW)).toBe("a");
		expect(ses.next(NOW)).toBeNull();
	});

	it("puts cards back at the front for undo", () => {
		const ses = new Session(["a", "b", "c"]);
		const a = ses.next(NOW)!;
		const b = ses.next(NOW)!;
		ses.putBack(b);
		ses.putBack(a);
		expect([ses.next(NOW), ses.next(NOW), ses.next(NOW)]).toEqual(["a", "b", "c"]);
	});
});
