// Desenvolvimento: servidor do Vite (HMR no renderer) + esbuild em watch no
// main/preload/worker, reiniciando o Electron a cada rebuild.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import * as esbuild from "esbuild";
import { createServer } from "vite";
import { mainBuildOptions } from "./esbuild.config.mjs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

const server = await createServer({ configFile: "vite.config.mts" });
await server.listen();
const url = server.resolvedUrls.local[0];
console.log(`renderer em ${url}`);

let child = null;
let restarting = false;
function startElectron() {
  child = spawn(electronPath, ["."], {
    stdio: "inherit",
    env: { ...process.env, VITE_DEV_SERVER_URL: url },
  });
  child.on("exit", () => {
    if (!restarting) {
      void server.close();
      process.exit(0);
    }
  });
}

const ctx = await esbuild.context({
  ...mainBuildOptions({ production: false }),
  plugins: [
    {
      name: "restart-electron",
      setup(build) {
        build.onEnd((result) => {
          if (result.errors.length) return;
          if (child) {
            restarting = true;
            child.once("exit", () => {
              restarting = false;
              startElectron();
            });
            child.kill();
          } else {
            startElectron();
          }
        });
      },
    },
  ],
});
await ctx.watch();
