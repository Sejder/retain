import { Component, MarkdownRenderer, Notice, setIcon } from "obsidian";
import { Grade, Rating } from "ts-fsrs";
import type RetainPlugin from "../main";
import { buildCramQueue, buildReviewQueue, CardFilter, Session } from "../queue";
import { GRADES } from "../scheduler";
import { LiveCard, localDate, Snapshot } from "../store";
import { header, iconButton, Mode, RetainModal } from "./RetainModal";

const GRADE_LABELS: Record<number, string> = {
	[Rating.Again]: "Again",
	[Rating.Hard]: "Hard",
	[Rating.Good]: "Good",
	[Rating.Easy]: "Easy",
};

interface UndoEntry {
	id: string;
	/** Undefined in cram mode, where nothing is written. */
	snap?: Snapshot;
}

/** One review sitting inside the modal: shows cards, grades them, supports undo and editing. */
export class ReviewView {
	private session: Session;
	private current: LiveCard | null = null;
	private revealed = false;
	private editing = false;
	private undoStack: UndoEntry[] = [];
	private component = new Component();

	constructor(
		private plugin: RetainPlugin,
		private modal: RetainModal,
		private el: HTMLElement,
		private filter: CardFilter,
		private label: string,
		private mode: Mode,
	) {
		const now = new Date();
		const s = plugin.db.settings;
		const ids =
			mode === "review"
				? buildReviewQueue(plugin.store, filter, now, s.newPerDay, localDate(now))
				: buildCramQueue(plugin.store, filter);
		this.session = new Session(ids);
		this.component.load();
		this.nextCard();
	}

	destroy(): void {
		this.component.unload();
	}

	/** Keyboard handling; returns false when the key was used. */
	handleKey(evt: KeyboardEvent): boolean {
		const target = evt.target as HTMLElement | null;
		if (this.editing || target?.closest("input, textarea, select")) return true;
		const mod = evt.ctrlKey || evt.metaKey;
		if (mod && evt.key.toLowerCase() === "z") return this.undo(), false;
		if (mod || evt.altKey) return true;

		if (evt.key === " " || evt.key === "Enter") {
			if (!this.current) return true;
			if (this.revealed) this.grade(Rating.Good);
			else this.reveal();
			return false;
		}
		const n = Number(evt.key);
		if (this.revealed && n >= 1 && n <= 4) return this.grade(n as Grade), false;
		switch (evt.key.toLowerCase()) {
			case "u":
				return this.undo(), false;
			case "e":
				if (this.current) this.startEdit();
				return false;
			case "o":
				if (this.current) void this.openSource();
				return false;
		}
		return true;
	}

	private nextCard(): void {
		let id = this.session.next(new Date());
		// Skip cards deleted from their notes since the session started.
		while (id !== null && !this.plugin.store.live.has(id)) id = this.session.next(new Date());
		this.current = id === null ? null : this.plugin.store.live.get(id)!;
		this.revealed = false;
		this.editing = false;
		this.render();
	}

	private reveal(): void {
		this.revealed = true;
		this.render();
	}

	private grade(rating: Grade): void {
		const card = this.current;
		if (!card || !this.revealed) return;
		const now = new Date();
		const { store, scheduler } = this.plugin;

		if (this.mode === "cram") {
			this.undoStack.push({ id: card.id });
			if (rating === Rating.Again) this.session.pushBack(card.id);
		} else {
			const snap = store.snapshot(card.id);
			const wasNew = store.isNew(card.id);
			const { card: next, log } = scheduler.grade(store.getFsrs(card.id, now), now, rating);
			store.applyReview(card.id, next, log);
			if (wasNew) store.bumpNew(card.deck, localDate(now));
			this.session.requeue(card.id, next.due, now);
			this.undoStack.push({ id: card.id, snap });
			this.plugin.changed();
		}
		this.nextCard();
	}

	private undo(): void {
		const entry = this.undoStack.pop();
		if (!entry) return;
		if (this.current) this.session.putBack(this.current.id);
		if (entry.snap) {
			this.plugin.store.restore(entry.snap);
			this.plugin.changed();
		}
		this.session.putBack(entry.id);
		this.nextCard();
	}

	private async openSource(): Promise<void> {
		if (!this.current) return;
		const card = this.current;
		this.modal.close();
		await this.plugin.openSource(card);
	}

	private startEdit(): void {
		this.editing = true;
		this.render();
	}

	private render(): void {
		this.component.unload();
		this.component = new Component();
		this.component.load();
		this.el.empty();

		const h = header(this.el, this.mode === "cram" ? "shuffle" : "layers", this.label);
		h.el.addClass("retain-review-header");
		const back = h.el.createDiv({ cls: "clickable-icon retain-icon-button", attr: { "aria-label": "Back to decks" } });
		setIcon(back, "arrow-left");
		back.addEventListener("click", () => this.modal.showDecks());
		h.el.prepend(back);

		if (this.current) h.right.createDiv({ cls: "retain-remaining", text: `${this.session.remaining + 1} left` });
		const undo = iconButton(h.right, "undo-2", "Undo (U)", () => this.undo());
		undo.toggleClass("is-disabled", this.undoStack.length === 0);
		if (this.current) {
			iconButton(h.right, "file-text", "Open note (O)", () => void this.openSource());
			iconButton(h.right, "pencil", "Edit card (E)", () => this.startEdit());
		}
		iconButton(h.right, "x", "Close", () => this.modal.close());

		if (!this.current) {
			const done = this.el.createDiv("retain-done");
			done.createDiv({ cls: "retain-done-title", text: "All done for now" });
			done.createDiv({
				cls: "retain-done-sub",
				text: this.mode === "cram" ? "You went through every card." : "Nothing else is due in this deck.",
			});
			new ButtonRow(done).button("Back to decks", true, () => this.modal.showDecks());
			return;
		}

		if (this.editing) return this.renderEditor(this.current);

		const body = this.el.createDiv("retain-card");
		if (this.mode === "cram") body.createDiv({ cls: "retain-badge", text: "Cram: schedule unchanged" });
		else if (this.plugin.store.isNew(this.current.id)) body.createDiv({ cls: "retain-badge", text: "New" });
		this.renderMarkdown(body.createDiv("retain-question"), this.current.question);
		if (this.revealed) {
			body.createEl("hr");
			this.renderMarkdown(body.createDiv("retain-answer"), this.current.answer);
		}

		const actions = this.el.createDiv("retain-actions");
		if (!this.revealed) {
			new ButtonRow(actions).button("Show answer", true, () => this.reveal(), "Space");
			return;
		}
		const showPreview = this.mode === "review" && this.plugin.db.settings.showPreviews;
		const previews = showPreview
			? this.plugin.scheduler.preview(this.plugin.store.getFsrs(this.current.id), new Date())
			: null;
		const row = new ButtonRow(actions, "retain-grades");
		for (const g of GRADES) {
			row.button(GRADE_LABELS[g], g === Rating.Good, () => this.grade(g), String(g), previews?.[g], `retain-grade-${g}`);
		}
	}

	private renderEditor(card: LiveCard): void {
		const form = this.el.createDiv("retain-card retain-editor");
		form.createEl("label", { text: "Question" });
		const q = form.createEl("textarea", { cls: "retain-edit-input" });
		q.value = card.question;
		form.createEl("label", { text: "Answer" });
		const a = form.createEl("textarea", { cls: "retain-edit-input" });
		a.value = card.answer;
		form.createDiv({ cls: "retain-edit-hint", text: "Cards are single-line; line breaks become spaces." });

		const save = async () => {
			const oneLine = (s: string) => s.replace(/\s*\n\s*/g, " ").trim();
			const updated = await this.plugin.editCard(card, oneLine(q.value), oneLine(a.value));
			if (!updated) return;
			for (const e of this.undoStack) {
				if (e.id !== card.id) continue;
				e.id = updated.id;
				if (e.snap) e.snap.id = updated.id;
			}
			this.current = updated;
			this.editing = false;
			new Notice("Card updated");
			this.render();
		};
		const cancel = () => {
			this.editing = false;
			this.render();
		};
		const actions = this.el.createDiv("retain-actions");
		new ButtonRow(actions).button("Cancel", false, cancel).button("Save", true, () => void save());
		form.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				void save();
			} else if (e.key === "Escape") {
				e.preventDefault();
				e.stopPropagation();
				cancel();
			}
		});
		window.setTimeout(() => q.focus(), 0);
	}

	private renderMarkdown(el: HTMLElement, md: string): void {
		void MarkdownRenderer.render(this.plugin.app, md, el, this.current?.path ?? "", this.component);
	}
}

class ButtonRow {
	private row: HTMLElement;

	constructor(parent: HTMLElement, cls = "") {
		this.row = parent.createDiv({ cls: `retain-button-row ${cls}`.trim() });
	}

	button(text: string, cta: boolean, onClick: () => void, key?: string, sub?: string, cls?: string): this {
		const b = this.row.createEl("button", { cls: cls ?? "" });
		if (cta) b.addClass("mod-cta");
		b.createSpan({ cls: "retain-button-text", text });
		if (sub) b.createSpan({ cls: "retain-button-sub", text: sub });
		if (key) b.createSpan({ cls: "retain-button-key", text: key });
		b.addEventListener("click", onClick);
		return this;
	}
}
