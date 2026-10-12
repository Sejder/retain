import esbuild from "esbuild";
import { builtinModules } from "node:module";
import { deploy } from "./scripts/deploy.mjs";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/*",
		"@lezer/*",
		...builtinModules,
		...builtinModules.map((m) => `node:${m}`),
	],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "main.js",
	minify: prod,
	plugins: prod ? [] : [{
		name: "deploy-on-rebuild",
		setup(build) {
			build.onEnd((result) => {
				if (result.errors.length === 0) deploy();
			});
		},
	}],
});

if (prod) {
	await context.rebuild();
	process.exit(0);
} else {
	await context.watch();
}
