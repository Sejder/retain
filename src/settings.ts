export interface RetainSettings {
	/** Tag that marks flashcards, e.g. "#flashcards". Subtags become decks. */
	tag: string;
	/** Separator between question and answer on a single line. */
	separator: string;
	/** Max new cards introduced per deck per day. */
	newPerDay: number;
	/** FSRS target retention (0.7–0.99). */
	retention: number;
	/** Max interval in days. */
	maxInterval: number;
	fuzz: boolean;
	showPreviews: boolean;
}

export const DEFAULT_SETTINGS: RetainSettings = {
	tag: "#flashcards",
	separator: "::",
	newPerDay: 20,
	retention: 0.9,
	maxInterval: 36500,
	fuzz: true,
	showPreviews: true,
};
