// Copies the built plugin into a vault's plugin folder. Set VAULT=/path/to/vault.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function deploy() {
	const vault = process.env.VAULT;
	if (!vault) {
		console.log("VAULT not set; skipping deploy");
		return;
	}
	const { id } = JSON.parse(readFileSync("manifest.json", "utf8"));
	const target = join(vault, ".obsidian", "plugins", id);
	mkdirSync(target, { recursive: true });
	for (const file of ["main.js", "manifest.json", "styles.css"]) {
		copyFileSync(file, join(target, file));
	}
	console.log(`deployed to ${target}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) deploy();
