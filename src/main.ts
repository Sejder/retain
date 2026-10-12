import { debounce, getAllTags, MarkdownView, Notice, parseFrontMatterTags, Plugin, TAbstractFile, TFile } from "obsidian";
import { deckFromTag, listPrefix, parseNote, splitCard, tagBase } from "./parser";
import { Scheduler } from "./scheduler";
import { RetainSettingTab } from "./ui/SettingTab";
import { CardStore, LiveCard, normalizeData, RetainData } from "./store";
import type { CardFilter } from "./queue";
import { RetainModal } from "./ui/RetainModal";
import { StatsModal } from "./ui/StatsModal";

export default class RetainPlugin extends Plugin {
	db!: RetainData;
	store!: CardStore;
	scheduler!: Scheduler;
	/** Deck paths collapsed in the deck list; kept for the session. */
	readonly collapsed = new Set<string>();
	/** Called whenever the card index or review state changes. */
	readonly listeners = new Set<() => void>();
	private statusEl!: HTMLElement;
	private requestSave = debounce(() => void this.saveData(this.db), 1000, true);
	/** Typing a new tag or separator triggers one rescan once typing stops. */
	private requestRescan = debounce(() => void this.rescan(false), 1000, true);

	async onload(): Promise<void> {
		this.db = normalizeData(await this.loadData());
		this.store = new CardStore(this.db);
		this.scheduler = new Scheduler(this.db.settings);

		this.addSettingTab(new RetainSettingTab(this.app, this));
		this.addRibbonIcon("layers", "Review flashcards", () => this.openDecks());

		this.addCommand({ id: "review", name: "Review flashcards", callback: () => this.openDecks() });
		this.addCommand({
			id: "review-current-note",
			name: "Review flashcards in current note",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!file || !this.store.hasFile(file.path)) return false;
				if (!checking) this.openReview({ path: file.path }, file.basename);
				return true;
			},
		});
		this.addCommand({ id: "stats", name: "Open stats", callback: () => new StatsModal(this.app, this).open() });
		this.addCommand({ id: "rescan", name: "Rescan vault", callback: () => void this.rescan(true) });

		this.statusEl = this.addStatusBarItem();
		this.statusEl.addClass("mod-clickable");
		this.statusEl.addEventListener("click", () => this.openDecks());

		this.app.workspace.onLayoutReady(async () => {
			await this.scanVault();
			this.registerEvent(
				this.app.metadataCache.on("changed", (file, data) => {
					void this.scanFile(file, data).then((touched) => touched && this.changed());
				}),
			);
			this.registerEvent(
				this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
					if (!(file instanceof TFile) || !this.store.hasFile(oldPath)) return;
					this.store.renameFile(oldPath, file.path);
					this.changed();
				}),
			);
			this.registerEvent(
				this.app.vault.on("delete", (file: TAbstractFile) => {
					if (!(file instanceof TFile) || !this.store.hasFile(file.path)) return;
					this.store.removeFile(file.path);
					this.changed();
				}),
			);
		});
		this.registerInterval(window.setInterval(() => this.updateStatus(), 60_000));
	}

	onunload(): void {
		void this.saveData(this.db);
	}

	/** Persists (debounced) and refreshes anything showing counts. */
	changed(): void {
		this.requestSave();
		this.updateStatus();
		for (const l of this.listeners) l();
	}

	async saveSettings(rescan = false): Promise<void> {
		this.scheduler.configure(this.db.settings);
		await this.saveData(this.db);
		if (rescan) this.requestRescan();
	}

	async rescan(notify: boolean): Promise<void> {
		this.store = new CardStore(this.db);
		await this.scanVault();
		if (notify) new Notice(`Retain: ${this.store.live.size} cards`);
	}

	openDecks(): void {
		new RetainModal(this.app, this).open();
	}

	openReview(filter: CardFilter, label: string): void {
		new RetainModal(this.app, this, { filter, label }).open();
	}

	private async scanVault(): Promise<void> {
		for (const file of this.app.vault.getMarkdownFiles()) await this.scanFile(file);
		this.store.pruneOrphans();
		this.changed();
	}

	/** Re-indexes one note. Returns whether it holds (or held) flashcards. */
	private async scanFile(file: TFile, content?: string): Promise<boolean> {
		if (file.extension !== "md") return false;
		const cache = this.app.metadataCache.getFileCache(file);
		const base = tagBase(this.db.settings.tag);
		const tagged = !cache || (getAllTags(cache) ?? []).some((t) => deckFromTag(t, base) !== null);
		if (!tagged) {
			if (!this.store.hasFile(file.path)) return false;
			this.store.reconcileFile(file.path, []);
			return true;
		}
		const text = content ?? (await this.app.vault.cachedRead(file));
		const fmTags = parseFrontMatterTags(cache?.frontmatter) ?? [];
		const opts = { tag: this.db.settings.tag, separator: this.db.settings.separator };
		this.store.reconcileFile(file.path, parseNote(text, opts, fmTags));
		return true;
	}

	updateStatus(): void {
		const now = new Date();
		let due = 0;
		for (const id of this.store.live.keys()) {
			const d = this.store.due(id);
			if (d !== null && d <= now) due++;
		}
		this.statusEl.setText(due > 0 ? `${due} due` : "");
		this.statusEl.setAttr("aria-label", "Review flashcards");
	}

	async openSource(card: LiveCard): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(card.path);
		if (!(file instanceof TFile)) return;
		const leaf = this.app.workspace.getLeaf(false);
		await leaf.openFile(file, { eState: { line: card.line } });
		if (leaf.view instanceof MarkdownView) {
			const pos = { line: card.line, ch: 0 };
			leaf.view.editor.setCursor(pos);
			leaf.view.editor.scrollIntoView({ from: pos, to: pos }, true);
		}
	}

	/** Rewrites a card's line in its note and keeps its review state. Returns the updated card. */
	async editCard(card: LiveCard, question: string, answer: string): Promise<LiveCard | null> {
		const file = this.app.vault.getAbstractFileByPath(card.path);
		if (!(file instanceof TFile)) return null;
		const sep = this.db.settings.separator;
		const parsed = splitCard(`${question}${sep}${answer}`, sep);
		if (!parsed || parsed.question !== question.trim() || parsed.answer !== answer.trim()) {
			new Notice(`The question can't contain "${sep}", and neither side can be empty.`);
			return null;
		}

		let line = -1;
		const text = await this.app.vault.process(file, (data) => {
			const lines = data.split("\n");
			const same = (l: string) => {
				const c = splitCard(l.replace(/\r$/, ""), sep);
				return c !== null && c.question === card.question && c.answer === card.answer;
			};
			line = lines[card.line] !== undefined && same(lines[card.line]) ? card.line : lines.findIndex(same);
			if (line < 0) return data;
			const cr = lines[line].endsWith("\r") ? "\r" : "";
			lines[line] = `${listPrefix(lines[line])}${parsed.question}${sep}${parsed.answer}${cr}`;
			return lines.join("\n");
		});
		if (line < 0) {
			new Notice("Couldn't find this card in its note anymore.");
			return null;
		}

		await this.scanFile(file, text);
		const updated = [...this.store.live.values()].find((c) => c.path === card.path && c.line === line) ?? null;
		// Big rewrites can fall below the fuzzy-match threshold; we know which card it was, so move it directly.
		if (updated && updated.id !== card.id && this.db.cards[card.id] && !this.db.cards[updated.id]) {
			this.store.moveState(card.id, updated.id);
			const s = this.db.cards[updated.id];
			s.question = updated.question;
			s.path = updated.path;
			delete s.orphanedAt;
		}
		this.changed();
		return updated;
	}
}
