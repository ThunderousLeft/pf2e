import { ConditionSource } from "@item/data/index.ts";
import { execSync } from "child_process";
import esbuild from "esbuild";
import fs from "fs-extra";
import path from "path";
import Peggy from "peggy";
import * as Vite from "vite";
import checker from "vite-plugin-checker";
import { viteStaticCopy } from "vite-plugin-static-copy";
import tsconfigPaths from "vite-tsconfig-paths";
import packageJSON from "./package.json" assert { type: "json" };

const CONDITION_SOURCES = ((): ConditionSource[] => {
    const output = execSync("npm run build:conditions", { encoding: "utf-8" });
    return JSON.parse(output.slice(output.indexOf("[")));
})();

const config = Vite.defineConfig(({ command, mode }): Vite.UserConfig => {
    const buildMode = mode === "production" ? "production" : "development";
    const rollGrammar = fs.readFileSync("roll-grammar.peggy", { encoding: "utf-8" });
    const outDir = "dist";

    const plugins = [checker({ typescript: true }), tsconfigPaths()];
    // Handle minification after build to allow for tree-shaking and whitespace minification
    // "Note the build.minify option does not minify whitespaces when using the 'es' format in lib mode, as it removes
    // pure annotations and breaks tree-shaking."
    if (buildMode === "production") {
        plugins.push(
            {
                name: "minify",
                renderChunk: {
                    order: "post",
                    async handler(code, chunk) {
                        return chunk.fileName.endsWith(".mjs")
                            ? esbuild.transform(code, {
                                  keepNames: true,
                                  minifyIdentifiers: false,
                                  minifySyntax: true,
                                  minifyWhitespace: true,
                              })
                            : code;
                    },
                },
            },
            ...viteStaticCopy({
                targets: [
                    { src: "CHANGELOG.md", dest: "." },
                    { src: "README.md", dest: "." },
                    { src: "CONTRIBUTING.md", dest: "." },
                ],
            }),
            {
                name: "hide-compendiums",
                apply: "build",
                writeBundle: {
                    async handler() {
                        const file = fs.openSync(path.resolve(outDir, "system.json"), "r+");
                        const data = JSON.parse(fs.readFileSync(file, { encoding: "utf8" }));
                        const pack = data.packs.find(
                            (p: { name: string; ownership: object }) => p.name === "kingmaker-features"
                        );
                        if (pack) {
                            pack.ownership = { GAMEMASTER: "NONE" };
                            fs.ftruncateSync(file);
                            fs.writeSync(file, JSON.stringify(data, null, 4), 0);
                        }
                        fs.closeSync(file);
                    },
                },
            }
        );
    } else {
        plugins.push(
            // Foundry expects all esm files listed in system.json to exist: create empty vendor module when in dev mode
            {
                name: "touch-vendor-mjs",
                apply: "build",
                writeBundle: {
                    async handler() {
                        fs.closeSync(fs.openSync(path.resolve(outDir, "vendor.mjs"), "w"));
                    },
                },
            },
            // Vite HMR is only preconfigured for css files: add handler for HBS templates
            {
                name: "hmr-handler",
                apply: "serve",
                handleHotUpdate(context) {
                    if (context.file.endsWith(".hbs") && !context.file.startsWith(outDir)) {
                        const basePath = context.file.slice(context.file.indexOf("templates/"));
                        console.log(`Updating template at ${basePath}`);
                        fs.promises.copyFile(context.file, `${outDir}/${basePath}`).then(() => {
                            context.server.ws.send({
                                type: "custom",
                                event: "template-update",
                                data: { path: `systems/pf2e/${basePath}` },
                            });
                        });
                    }
                },
            }
        );
    }

    // Create dummy files for vite dev server
    if (command === "serve") {
        const message = "This file is for a running vite dev server and is not copied to a build";
        fs.writeFileSync("./index.html", `<h1>${message}</h1>\n`);
        if (!fs.existsSync("./styles")) fs.mkdirSync("./styles");
        fs.writeFileSync("./styles/pf2e.css", `/** ${message} */\n`);
        fs.writeFileSync("./pf2e.mjs", `/** ${message} */\n\nimport "./src/pf2e.ts";\n`);
        fs.writeFileSync("./vendor.mjs", `/** ${message} */\n`);
    }

    return {
        base: command === "build" ? "./" : "/systems/pf2e/",
        publicDir: "static",
        define: {
            BUILD_MODE: JSON.stringify(buildMode),
            CONDITION_SOURCES: JSON.stringify(CONDITION_SOURCES),
            ROLL_PARSER: Peggy.generate(rollGrammar, { output: "source" }),
        },
        esbuild: { keepNames: true },
        build: {
            outDir,
            emptyOutDir: false, // fails if world is running due to compendium locks. We do it in "npm run clean" instead.
            minify: false,
            sourcemap: buildMode === "development",
            lib: {
                name: "pf2e",
                entry: "src/pf2e.ts",
                formats: ["es"],
                fileName: "pf2e",
            },
            rollupOptions: {
                output: {
                    assetFileNames: ({ name }): string => (name === "style.css" ? "styles/pf2e.css" : name!),
                    chunkFileNames: "[name].mjs",
                    entryFileNames: "pf2e.mjs",
                    manualChunks: {
                        vendor: buildMode === "production" ? Object.keys(packageJSON.dependencies) : [],
                    },
                },
                watch: { buildDelay: 100 },
            },
        },
        server: {
            port: 30001,
            open: "/game",
            proxy: {
                "^(?!/systems/pf2e/)": "http://localhost:30000/",
                "/socket.io": {
                    target: "ws://localhost:30000",
                    ws: true,
                },
            },
        },
        plugins,
        css: {
            devSourcemap: buildMode === "development",
        },
    };
});

export default config;
