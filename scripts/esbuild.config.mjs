// Main, preload e o utility process de áudio: CommonJS para o Node do Electron.
// O preload roda com sandbox: vai num arquivo só, sem require além de "electron".
export function mainBuildOptions({ production }) {
  return {
    entryPoints: {
      "main/index": "src/main/index.ts",
      "preload/index": "src/preload/index.ts",
      "audio/worker": "src/audio/worker.ts",
    },
    outdir: "dist",
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node22",
    external: ["electron", "electron-updater"],
    sourcemap: production ? false : "inline",
    minify: production,
    logLevel: "info",
    define: {
      __MYSCREEN_SERVER_URL__: JSON.stringify(process.env.MYSCREEN_SERVER_URL || "https://myscreen.haumea.fun"),
    },
  };
}
