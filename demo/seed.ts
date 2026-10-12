// Fills demo/vault with 30 days of simulated review history, for screenshots.
// Run with: npm run demo:seed
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fsrs, Grade, Rating } from "ts-fsrs";
import { parseNote } from "../src/parser";
import { CardStore, emptyData, localDate } from "../src/store";

const VAULT = join(import.meta.dirname, "vault");
const DAYS = 30;

// Deterministic RNG so screenshots are reproducible.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((f) => {
		if (f.startsWith(".")) return [];
		const p = join(dir, f);
		return statSync(p).isDirectory() ? walk(p) : p.endsWith(".md") ? [p] : [];
	});
}

const data = emptyData();
const store = new CardStore(data);
for (const file of walk(VAULT)) {
	store.reconcileFile(relative(VAULT, file), parseNote(readFileSync(file, "utf8"), data.settings));
}

const f = fsrs({ enable_fuzz: true });
const now = new Date();
const ids = [...store.live.keys()];
// Leave a few cards untouched so the deck list shows new cards.
const pool = ids.filter(() => rand() < 0.8);

for (let d = DAYS; d >= 4; d--) {
	const day = new Date(now);
	day.setDate(day.getDate() - d);
	day.setHours(18, 0, 0, 0);
	let introduced = 0;
	for (const id of pool) {
		const when = new Date(day.getTime() + Math.floor(rand() * 3 * 3600_000));
		const due = store.due(id);
		const isNew = due === null;
		if (isNew && (introduced >= 4 || rand() < 0.5)) continue;
		if (!isNew && due! > when) continue;
		if (isNew) introduced++;
		const r = rand();
		const rating: Grade = r < 0.1 ? Rating.Again : r < 0.22 ? Rating.Hard : r < 0.9 ? Rating.Good : Rating.Easy;
		const { card, log } = f.next(store.getFsrs(id, when), when, rating);
		store.applyReview(id, card, log);
	}
}
data.newToday = { date: localDate(now), count: {} };

const out = join(VAULT, ".obsidian", "plugins", "retain");
mkdirSync(out, { recursive: true });
writeFileSync(join(out, "data.json"), JSON.stringify(data, null, "\t"));
const due = ids.filter((id) => (store.due(id) ?? now) < now).length;
console.log(`${ids.length} cards, ${data.log.length} reviews, ${due} due now`);
