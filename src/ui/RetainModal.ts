import { App, DropdownComponent, Modal, Notice, Platform, setIcon } from "obsidian";
import type RetainPlugin from "../main";
import { CardFilter, DeckNode, deckTree } from "../queue";
import { localDate } from "../store";
import { ReviewView } from "./ReviewView";
import { StatsModal } from "./StatsModal";

export type Mode = "review" | "cram";

/** Adds the shared modal chrome: our own header and a single close button. */
export function setupModal(modal: Modal, extraClass: string): void {
	modal.modalEl.addClass("retain-modal", extraClass);
	if (Platform.isMobile) modal.modalEl.addClass("retain-mobile");
}

export function iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): HTMLElement {
	const el = parent.createDiv({ cls: "clickable-icon retain-icon-button", attr: { "aria-label": label, role: "button" } });
	setIcon(el, icon);
	el.addEventListener("click", onClick);
	return el;
}

export function header(parent: HTMLElement, icon: string, title: string): { el: HTMLElement; right: HTMLElement } {
	const el = parent.createDiv("retain-header");
	setIcon(el.createDiv("retain-header-icon"), icon);
	el.createDiv({ cls: "retain-title", text: title });
	el.createDiv("retain-spacer");
	const right = el.createDiv("retain-header-right");
	return { el, right };
}

export class RetainModal extends Modal {
	mode: Mode = "review";
	private review: ReviewView | null = null;
	private onIndexChange = () => {
		if (!this.review) this.showDecks();
	};

	constructor(
		app: App,
		private plugin: RetainPlugin,
		private initial?: { filter: CardFilter; label: string },
	) {
		super(app);
		this.scope.register(null, null, (evt) => (this.review ? this.review.handleKey(evt) : true));
	}

	onOpen(): void {
		setupModal(this, "retain-main");
		this.plugin.listeners.add(this.onIndexChange);
		if (this.initial) this.startReview(this.initial.filter, this.initial.label);
		else this.showDecks();
	}

	onClose(): void {
		this.plugin.listeners.delete(this.onIndexChange);
		this.review?.destroy();
		this.review = null;
		this.contentEl.empty();
	}

	showDecks(): void {
		this.review?.destroy();
		this.review = null;
		const { contentEl } = this;
		contentEl.empty();

		const h = header(contentEl, "layers", "Decks");
		new DropdownComponent(h.right)
			.addOptions({ review: "Review", cram: "Cram" })
			.setValue(this.mode)
			.onChange((v) => {
				this.mode = v as Mode;
			});
		iconButton(h.right, "bar-chart-2", "Stats", () => new StatsModal(this.app, this.plugin).open());
		iconButton(h.right, "x", "Close", () => this.close());

		const now = new Date();
		const s = this.plugin.db.settings;
		const tree = deckTree(this.plugin.store, now, s.newPerDay, localDate(now));

		const list = contentEl.createDiv("retain-deck-list");
		const head = list.createDiv("retain-deck-row retain-deck-head");
		head.createDiv({ cls: "retain-deck-name", text: "Deck" });
		for (const [cls, text] of [["due", "Due"], ["new", "New"], ["total", "Total"]]) {
			head.createDiv({ cls: `retain-count retain-${cls}-label`, text });
		}

		if (tree.total === 0) {
			list.createDiv({
				cls: "retain-empty",
				text: `No cards found. Add ${s.tag} to a heading and write cards as "Question${s.separator}Answer".`,
			});
			return;
		}

		this.renderNode(list, tree, 0);
	}

	private renderNode(parent: HTMLElement, node: DeckNode, depth: number): void {
		const row = parent.createDiv("retain-deck-row");
		row.setCssProps({ "--retain-depth": String(depth) });
		const name = row.createDiv("retain-deck-name");
		const collapsed = this.plugin.collapsed.has(node.path);
		const toggle = name.createDiv("retain-deck-toggle");
		if (node.children.length && node.path !== "") {
			setIcon(toggle, collapsed ? "chevron-right" : "chevron-down");
			toggle.addEventListener("click", (e) => {
				e.stopPropagation();
				if (collapsed) this.plugin.collapsed.delete(node.path);
				else this.plugin.collapsed.add(node.path);
				this.showDecks();
			});
		}
		name.createSpan({ text: node.name });
		for (const [cls, n] of [["due", node.due], ["new", node.new], ["total", node.total]] as const) {
			row.createDiv({ cls: `retain-count retain-${cls}${n === 0 ? " is-zero" : ""}`, text: String(n) });
		}

		row.addEventListener("click", () => {
			if (this.mode === "review" && node.due + node.new === 0) {
				new Notice("Nothing due here right now. Switch to Cram to go through it anyway.");
				return;
			}
			const filter = node.path ? { deck: node.path } : {};
			this.startReview(filter, node.path ? node.path.split("/").join(" / ") : node.name);
		});

		if (collapsed) return;
		for (const child of node.children) this.renderNode(parent, child, depth + 1);
	}

	startReview(filter: CardFilter, label: string): void {
		this.review?.destroy();
		this.contentEl.empty();
		this.review = new ReviewView(this.plugin, this, this.contentEl, filter, label, this.mode);
	}
}

