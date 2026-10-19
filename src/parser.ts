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
	/** Last line of the card; equals `line` for single-line cards. */
	endLine: number;
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
 * Finds single-line and block cards in a note. Only lines inside a flashcard-tagged scope count:
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
	const bodyStart = i;
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
	// Paragraphs: runs of lines between blank lines and headings. Blank lines inside code or math don't split them.
	let para: number[] = [];
	const flush = () => {
		const deck = scopes.length ? scopes[scopes.length - 1].deck : noteDeck;
		if (deck !== null && para.length) cards.push(...paragraphCards(lines, para, skip, opts.separator, deck));
		para = [];
	};
	for (let j = bodyStart; j < lines.length; j++) {
		const line = lines[j];
		if (!skip[j] && !line.trim()) {
			flush();
			continue;
		}
		const h = skip[j] ? null : HEADING_RE.exec(line);
		if (h) {
			flush();
			const level = h[1].length;
			while (scopes.length && scopes[scopes.length - 1].level >= level) scopes.pop();
			const deck = findDeckTag(h[2], base);
			if (deck !== null) scopes.push({ level, deck });
			continue;
		}
		para.push(j);
	}
	flush();
	return cards;
}

/**
 * Cards in one paragraph. A paragraph with exactly one bare separator line and no single-line
 * cards is a block card: everything above the separator is the question, everything below the answer.
 * Otherwise each line is checked as a single-line card.
 */
function paragraphCards(lines: string[], para: number[], skip: boolean[], sep: string, deck: string): ParsedCard[] {
	const bare = para.filter((j) => !skip[j] && lines[j].trim() === sep);
	const inline = para.filter((j) => !skip[j] && lines[j].trim() !== sep && findSeparator(lines[j], sep) >= 0);
	if (bare.length === 1 && inline.length === 0) {
		const k = para.indexOf(bare[0]);
		const question = para.slice(0, k).map((j) => lines[j]).join("\n").trim();
		const answer = para.slice(k + 1).map((j) => lines[j]).join("\n").trim();
		if (!question || !answer) return [];
		return [{ question, answer, deck, line: para[0], endLine: para[para.length - 1] }];
	}
	const cards: ParsedCard[] = [];
	for (const j of inline) {
		const card = splitCard(lines[j], sep);
		if (card) cards.push({ ...card, deck, line: j, endLine: j });
	}
	return cards;
}
