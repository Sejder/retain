import { App, PluginSettingTab, Setting } from "obsidian";
import type RetainPlugin from "../main";

export class RetainSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: RetainPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.db.settings;
		const save = async (rescan = false) => {
			await this.plugin.saveSettings(rescan);
		};

		new Setting(containerEl)
			.setName("Flashcard tag")
			.setDesc("Put this tag on a heading (or anywhere in a note) to mark flashcards. Subtags like #flashcards/ml/w01 become nested decks.")
			.addText((t) =>
				t.setPlaceholder("#flashcards").setValue(s.tag).onChange(async (v) => {
					const tag = v.trim();
					if (!tag) return;
					s.tag = tag.startsWith("#") ? tag : `#${tag}`;
					await save(true);
				}),
			);

		new Setting(containerEl)
			.setName("Separator")
			.setDesc("Separates question and answer on one line.")
			.addText((t) =>
				t.setPlaceholder("::").setValue(s.separator).onChange(async (v) => {
					if (!v) return;
					s.separator = v;
					await save(true);
				}),
			);

		new Setting(containerEl)
			.setName("New cards per day")
			.setDesc("Per deck.")
			.addText((t) =>
				t.setValue(String(s.newPerDay)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (Number.isNaN(n) || n < 0) return;
					s.newPerDay = n;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Target retention")
			.setDesc("Probability of recalling a card when it comes due. Higher means more reviews.")
			.addSlider((sl) =>
				sl
					.setLimits(0.7, 0.99, 0.01)
					.setValue(s.retention)
					.setDynamicTooltip()
					.onChange(async (v) => {
						s.retention = v;
						await save();
					}),
			);

		new Setting(containerEl)
			.setName("Maximum interval (days)")
			.addText((t) =>
				t.setValue(String(s.maxInterval)).onChange(async (v) => {
					const n = parseInt(v, 10);
					if (Number.isNaN(n) || n < 1) return;
					s.maxInterval = n;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Fuzz intervals")
			.setDesc("Slightly randomize intervals so cards added together don't stay bunched up.")
			.addToggle((t) =>
				t.setValue(s.fuzz).onChange(async (v) => {
					s.fuzz = v;
					await save();
				}),
			);

		new Setting(containerEl)
			.setName("Show interval previews")
			.setDesc("Show the next interval on each grade button.")
			.addToggle((t) =>
				t.setValue(s.showPreviews).onChange(async (v) => {
					s.showPreviews = v;
					await save();
				}),
			);
	}
}
