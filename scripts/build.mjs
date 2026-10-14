// Build de produção: renderer (Vite) + main, preload e worker de áudio (esbuild).
import { build as viteBuild } from "vite";
import { mainBuildOptions } from "./esbuild.config.mjs";
import * as esbuild from "esbuild";

await viteBuild({ configFile: "vite.config.mts", mode: "production", logLevel: "info" });
await esbuild.build(mainBuildOptions({ production: true }));
console.log("build ok → dist/");
