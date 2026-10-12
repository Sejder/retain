import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { deckFromTag, parseNote, splitCard } from "../src/parser";

const opts = { tag: "#flashcards", separator: "::" };

const NOTE = `---
status: review
tags: [ml, ml/w01]
---
# Decision Trees
**Source:** lecture notes

## Intuition
Some text with a dataview field:: not a card

## Flashcards #flashcards/ml/w01
Entropy of a set with class fractions $p_i$?::$H(S)=-\\sum_i p_i\\log_2 p_i$
#parameters in a layer?::$mk+k$
- What does \`std::vector\` store?::A dynamic array
Reversed:::Card
Empty answer::
\`\`\`python
x = {"a"::1}
\`\`\`
$$
a::b
$$
### Subsection
Still in scope?::Yes

## Other section
Out of scope::Not a card
`;

describe("splitCard", () => {
	it("splits at the first separator and trims", () => {
		expect(splitCard("  Q ::  A::B ", "::")).toEqual({ question: "Q", answer: "A::B" });
	});
	it("rejects reversed cards and empty sides", () => {
		expect(splitCard("Q:::A", "::")).toBeNull();
		expect(splitCard("::A", "::")).toBeNull();
		expect(splitCard("Q::", "::")).toBeNull();
	});
	it("ignores separators in inline code", () => {
		expect(splitCard("Is `a::b` code?::yes", "::")).toEqual({ question: "Is `a::b` code?", answer: "yes" });
	});
	it("strips list markers and old SR comments", () => {
		expect(splitCard("- Q::A <!--SR:!2026-01-01,1,230-->", "::")).toEqual({ question: "Q", answer: "A" });
	});
});

describe("deckFromTag", () => {
	it("maps tags to decks", () => {
		expect(deckFromTag("#flashcards", "flashcards")).toBe("default");
		expect(deckFromTag("#flashcards/ml/w01", "flashcards")).toBe("ml/w01");
		expect(deckFromTag("#Flashcards/ML", "flashcards")).toBe("ML");
		expect(deckFromTag("#flashcardsx", "flashcards")).toBeNull();
	});
});

describe("parseNote", () => {
	const cards = parseNote(NOTE, opts);

	it("finds cards only inside the tagged heading scope", () => {
		expect(cards.map((c) => c.question)).toEqual([
			"Entropy of a set with class fractions $p_i$?",
			"#parameters in a layer?",
			"What does `std::vector` store?",
			"Still in scope?",
		]);
	});

	it("does not treat #tags inside cards as decks", () => {
		expect(new Set(cards.map((c) => c.deck))).toEqual(new Set(["ml/w01"]));
	});

	it("records 0-based line numbers", () => {
		const lines = NOTE.split("\n");
		for (const c of cards) expect(lines[c.line]).toContain(c.question);
	});

	it("uses a note-level tag for cards outside headings", () => {
		const text = "#flashcards/bio\n\nWhat is ATP?::Energy currency\n## Notes\nCell?::Unit of life";
		expect(parseNote(text, opts).map((c) => [c.question, c.deck])).toEqual([
			["What is ATP?", "bio"],
			["Cell?", "bio"],
		]);
	});

	it("uses frontmatter tags", () => {
		expect(parseNote("Q::A", opts, ["#flashcards/fm"])).toEqual([{ question: "Q", answer: "A", deck: "fm", line: 0 }]);
	});

	it("ignores untagged notes", () => {
		expect(parseNote("Q::A\nkey:: value", opts)).toEqual([]);
	});
});

// Optional sanity check against a real vault: VAULT=/path/to/vault npm test
const VAULT = process.env.VAULT;
describe.skipIf(!VAULT || !existsSync(VAULT))("real vault", () => {
	it("parses every note without errors and finds cards", () => {
		const walk = (dir: string): string[] =>
			readdirSync(dir).flatMap((f) => {
				if (f.startsWith(".")) return [];
				const p = join(dir, f);
				return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
			});
		const decks = new Map<string, number>();
		for (const file of walk(VAULT!)) {
			for (const c of parseNote(readFileSync(file, "utf8"), opts)) decks.set(c.deck, (decks.get(c.deck) ?? 0) + 1);
		}
		console.log(Object.fromEntries([...decks].sort()));
		expect(decks.size).toBeGreaterThan(0);
	});
});
