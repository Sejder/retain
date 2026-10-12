import { App, PluginSettingTab, SettingDefinitionItem } from "obsidian";
import type RetainPlugin from "../main";
import type { RetainSettings } from "../settings";

type Key = keyof RetainSettings;

/** Declarative settings, so they show up in Obsidian's settings search. */
export class RetainSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: RetainPlugin,
	) {
		super(app, plugin);
		this.icon = "layers";
	}

	getSettingDefinitions(): SettingDefinitionItem<Key>[] {
		return [
			{
				type: "group",
				heading: "Cards",
				items: [
					{
						name: "Flashcard tag",
						desc: "Put this tag on a heading (or anywhere in a note) to mark flashcards. Subtags like #flashcards/spanish become nested decks.",
						aliases: ["deck", "tag"],
						control: {
							type: "text",
							key: "tag",
							placeholder: "#flashcards",
							validate: (v) => (v.trim().replace(/^#/, "") ? undefined : "Enter a tag"),
						},
					},
					{
						name: "Separator",
						desc: "Separates question and answer on one line.",
						control: {
							type: "text",
							key: "separator",
							placeholder: "::",
							validate: (v) => (v.trim() ? undefined : "Enter a separator"),
						},
					},
				],
			},
			{
				type: "group",
				heading: "Scheduling",
				items: [
					{
						name: "New cards per day",
						desc: "Per deck.",
						aliases: ["limit"],
						control: { type: "number", key: "newPerDay", min: 0, step: 1 },
					},
					{
						name: "Target retention",
						desc: "Probability of recalling a card when it comes due. Higher means more reviews.",
						aliases: ["fsrs", "retention"],
						control: {
							type: "slider",
							key: "retention",
							min: 0.7,
							max: 0.99,
							step: 0.01,
							displayFormat: (v) => `${Math.round(v * 100)}%`,
						},
					},
					{
						name: "Maximum interval",
						desc: "Longest gap between reviews, in days.",
						control: { type: "number", key: "maxInterval", min: 1, step: 1 },
					},
					{
						name: "Fuzz intervals",
						desc: "Slightly randomize intervals so cards added together don't stay bunched up.",
						control: { type: "toggle", key: "fuzz" },
					},
				],
			},
			{
				type: "group",
				heading: "Review",
				items: [
					{
						name: "Show interval previews",
						desc: "Show the next interval on each grade button.",
						control: { type: "toggle", key: "showPreviews" },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.db.settings[key as Key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.db.settings as unknown as Record<string, unknown>;
		if (key === "tag") {
			const tag = String(value).trim();
			if (!tag.replace(/^#/, "")) return;
			value = tag.startsWith("#") ? tag : `#${tag}`;
		}
		if (key === "separator" && !String(value)) return;
		if (typeof value === "number" && Number.isNaN(value)) return;
		settings[key] = value;
		await this.plugin.saveSettings(key === "tag" || key === "separator");
	}
}
