import { describe, expect, it } from "vitest";
import { createEmptyCard, fsrs, Rating, State } from "ts-fsrs";
import type { ParsedCard } from "../src/parser";
import { CardStore, emptyData, hashId, ORPHAN_DAYS, similarity } from "../src/store";

const card = (question: string, line = 0, deck = "d"): ParsedCard => ({ question, answer: "a", deck, line });
const f = fsrs();
const NOW = new Date("2026-10-12T10:00:00Z");

function review(store: CardStore, id: string, rating: Rating.Good | Rating.Again = Rating.Good) {
	const { card: next, log } = f.next(store.getFsrs(id, NOW), NOW, rating);
	store.applyReview(id, next, log);
}

describe("ids", () => {
	it("hash ignores case and whitespace", () => {
		expect(hashId("What  is X?")).toBe(hashId("what is x?"));
		expect(hashId("a")).not.toBe(hashId("b"));
	});
	it("similarity is 1 for equal, low for unrelated", () => {
		expect(similarity("Hello", "hello")).toBe(1);
		expect(similarity("What is entropy?", "What is the entropy?")).toBeGreaterThan(0.75);
		expect(similarity("What is entropy?", "Define overfitting")).toBeLessThan(0.4);
	});
});

describe("CardStore", () => {
	it("gives duplicate questions in a note distinct ids", () => {
		const s = new CardStore(emptyData());
		s.reconcileFile("a.md", [card("Q", 0), card("Q", 1)]);
		expect(s.live.size).toBe(2);
	});

	it("gives the same question in two notes distinct ids", () => {
		const s = new CardStore(emptyData());
		s.reconcileFile("a.md", [card("Q")]);
		s.reconcileFile("b.md", [card("Q")]);
		expect(s.live.size).toBe(2);
	});

	it("keeps state when a question is lightly edited", () => {
		const s = new CardStore(emptyData());
		s.reconcileFile("a.md", [card("What is the entropy of a pure set?"), card("Other")]);
		const id = hashId("What is the entropy of a pure set?");
		review(s, id);
		s.reconcileFile("a.md", [card("What is the entropy of a pure set??"), card("Other")]);
		const newId = hashId("What is the entropy of a pure set??");
		expect(s.isNew(newId)).toBe(false);
		expect(s.data.cards[id]).toBeUndefined();
		expect(s.data.log.every((e) => e.id === newId)).toBe(true);
	});

	it("orphans a rewritten card instead of matching it", () => {
		const s = new CardStore(emptyData());
		s.reconcileFile("a.md", [card("What is entropy?")]);
		review(s, hashId("What is entropy?"));
		s.reconcileFile("a.md", [card("Define overfitting")]);
		expect(s.data.cards[hashId("What is entropy?")].orphanedAt).toBeDefined();
		expect(s.isNew(hashId("Define overfitting"))).toBe(true);
	});

	it("keeps state when a card moves to another note (either scan order)", () => {
		for (const order of ["source-first", "target-first"]) {
			const s = new CardStore(emptyData());
			s.reconcileFile("a.md", [card("Moving card")]);
			s.reconcileFile("b.md", [card("Stays")]);
			review(s, hashId("Moving card"));
			if (order === "source-first") {
				s.reconcileFile("a.md", []);
				s.reconcileFile("b.md", [card("Stays"), card("Moving card", 1)]);
			} else {
				s.reconcileFile("b.md", [card("Stays"), card("Moving card", 1)]);
				s.reconcileFile("a.md", []);
			}
			const live = [...s.live.values()].find((c) => c.question === "Moving card")!;
			expect(live.path).toBe("b.md");
			expect(s.isNew(live.id)).toBe(false);
			expect(s.data.cards[live.id].orphanedAt).toBeUndefined();
			expect(Object.keys(s.data.cards)).toHaveLength(1);
		}
	});

	it("follows file renames", () => {
		const s = new CardStore(emptyData());
		s.reconcileFile("a.md", [card("Q")]);
		review(s, hashId("Q"));
		s.renameFile("a.md", "b.md");
		expect(s.data.cards[hashId("Q")].path).toBe("b.md");
		expect(s.live.get(hashId("Q"))!.path).toBe("b.md");
		expect(s.hasFile("b.md")).toBe(true);
	});

	it("prunes orphans after the grace period but keeps the log", () => {
		const s = new CardStore(emptyData());
		s.reconcileFile("a.md", [card("Q")]);
		review(s, hashId("Q"));
		s.removeFile("a.md", NOW);
		expect(s.pruneOrphans(new Date(NOW.getTime() + (ORPHAN_DAYS - 1) * 86_400_000))).toBe(0);
		expect(s.pruneOrphans(new Date(NOW.getTime() + (ORPHAN_DAYS + 1) * 86_400_000))).toBe(1);
		expect(s.data.log).toHaveLength(1);
	});

	it("restores a snapshot exactly (undo)", () => {
		const s = new CardStore(emptyData());
		s.reconcileFile("a.md", [card("Q")]);
		const id = hashId("Q");
		const snap = s.snapshot(id);
		review(s, id);
		s.bumpNew("d", "2026-10-12");
		s.restore(snap);
		expect(s.isNew(id)).toBe(true);
		expect(s.data.log).toHaveLength(0);
		expect(s.newCountToday("d", "2026-10-12")).toBe(0);
	});

	it("round-trips FSRS cards through JSON", () => {
		const s = new CardStore(emptyData());
		s.reconcileFile("a.md", [card("Q")]);
		review(s, hashId("Q"));
		const copy = new CardStore(JSON.parse(JSON.stringify(s.data)));
		const c = copy.getFsrs(hashId("Q"));
		expect(c.due).toBeInstanceOf(Date);
		expect(c.state).not.toBe(State.New);
		expect(c).toEqual(s.getFsrs(hashId("Q")));
		expect(createEmptyCard().state).toBe(State.New);
	});
});
