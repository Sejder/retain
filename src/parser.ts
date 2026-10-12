export interface ParseOptions {
	/** Flashcard tag, with or without the leading "#". */
	tag: string;
	separator: string;
}

export interface ParsedCard {
	question: string;
	answer: string;
	/** Deck path, e.g. "ml/w01", or "default" for the bare tag. */
	deck: string;
	/** 0-based line number in the note. */
	line: number;
}

const TAG_RE = /(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const LIST_PREFIX_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;
const FENCE_RE = /^\s*(```|~~~)/;
const SR_COMMENT_RE = /\s*<!--SR:.*?-->\s*$/;

/** Leading list marker ("- ", "1. ") of a line, kept when a card is edited. */
export function listPrefix(line: string): string {
	return LIST_PREFIX_RE.exec(line)?.[0] ?? "";
}

export function tagBase(tag: string): string {
	return tag.replace(/^#/, "").toLowerCase();
}

/** Deck for a tag like "flashcards/ml/w01" given base "flashcards", or null if unrelated. */
export function deckFromTag(tag: string, base: string): string | null {
	const t = tag.replace(/^#/, "");
	const lower = t.toLowerCase();
	if (lower === base) return "default";
	if (lower.startsWith(base + "/")) return t.slice(base.length + 1);
	return null;
}

function findDeckTag(text: string, base: string): string | null {
	for (const m of text.matchAll(TAG_RE)) {
		const deck = deckFromTag(m[1], base);
		if (deck !== null) return deck;
	}
	return null;
}

/** Index of the first separator outside inline code, or -1. */
function findSeparator(line: string, sep: string): number {
	let inCode = false;
	for (let i = 0; i < line.length; i++) {
		if (line[i] === "`") {
			inCode = !inCode;
			continue;
		}
		if (!inCode && line.startsWith(sep, i)) return i;
	}
	return -1;
}

/** Splits a single-line card. Returns null for non-cards and reversed (e.g. ":::") cards. */
export function splitCard(line: string, sep: string): { question: string; answer: string } | null {
	const body = line.replace(LIST_PREFIX_RE, "");
	const idx = findSeparator(body, sep);
	if (idx < 0) return null;
	// A longer run of the separator's last char (":::") is the reversed format, which we don't support.
	if (body[idx + sep.length] === sep[sep.length - 1]) return null;
	const question = body.slice(0, idx).trim();
	const answer = body.slice(idx + sep.length).replace(SR_COMMENT_RE, "").trim();
	if (!question || !answer) return null;
	return { question, answer };
}

/**
 * Finds single-line cards in a note. Only lines inside a flashcard-tagged scope count:
 * under a heading carrying the tag (until the next heading of the same or higher level),
 * or anywhere when the note itself carries the tag (frontmatter or a body line).
 */
export function parseNote(text: string, opts: ParseOptions, frontmatterTags: string[] = []): ParsedCard[] {
	const base = tagBase(opts.tag);
	const lines = text.split(/\r?\n/);

	// Classify lines: frontmatter, fenced code and $$ math blocks are never cards or tags.
	const skip = new Array<boolean>(lines.length).fill(false);
	let i = 0;
	if (lines[0]?.trim() === "---") {
		skip[0] = true;
		for (i = 1; i < lines.length; i++) {
			skip[i] = true;
			if (lines[i].trim() === "---") {
				i++;
				break;
			}
		}
	}
	let fence: string | null = null;
	let inMath = false;
	for (; i < lines.length; i++) {
		const line = lines[i];
		const f = FENCE_RE.exec(line);
		if (fence) {
			skip[i] = true;
			if (f && f[1] === fence) fence = null;
			continue;
		}
		if (f) {
			fence = f[1];
			skip[i] = true;
			continue;
		}
		if (line.trim() === "$$") {
			inMath = !inMath;
			skip[i] = true;
			continue;
		}
		if (inMath) skip[i] = true;
	}

	let noteDeck: string | null = null;
	for (const t of frontmatterTags) {
		noteDeck = deckFromTag(t, base);
		if (noteDeck !== null) break;
	}
	if (noteDeck === null) {
		for (let j = 0; j < lines.length && noteDeck === null; j++) {
			if (skip[j] || HEADING_RE.test(lines[j])) continue;
			if (findSeparator(lines[j], opts.separator) >= 0) continue;
			noteDeck = findDeckTag(lines[j], base);
		}
	}

	const cards: ParsedCard[] = [];
	const scopes: { level: number; deck: string }[] = [];
	for (let j = 0; j < lines.length; j++) {
		if (skip[j]) continue;
		const line = lines[j];
		const h = HEADING_RE.exec(line);
		if (h) {
			const level = h[1].length;
			while (scopes.length && scopes[scopes.length - 1].level >= level) scopes.pop();
			const deck = findDeckTag(h[2], base);
			if (deck !== null) scopes.push({ level, deck });
			continue;
		}
		const deck = scopes.length ? scopes[scopes.length - 1].deck : noteDeck;
		if (deck === null) continue;
		const card = splitCard(line, opts.separator);
		if (card) cards.push({ ...card, deck, line: j });
	}
	return cards;
}
