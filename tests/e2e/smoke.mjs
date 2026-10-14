// Ponta a ponta: abre o app empacotado (dist/), confere a home, as fontes de
// captura, o módulo de som nativo (captura real por 1,5 s) e o lobby com
// câmera falsa. Uso: npm run build && node tests/e2e/smoke.mjs [pasta-de-saida]
import { mkdirSync } from "node:fs";
import path from "node:path";
import { _electron as electron } from "playwright-core";

const out = process.argv[2] ?? "release/smoke";
mkdirSync(out, { recursive: true });

// MYSCREEN_EXE aponta para o executável empacotado (release/win-unpacked/MyScreen.exe).
const exe = process.env.MYSCREEN_EXE;
const app = await electron.launch({
  ...(exe ? { executablePath: exe } : {}),
  args: exe ? ["--use-fake-device-for-media-stream"] : [".", "--use-fake-device-for-media-stream"],
  env: { ...process.env, VITE_DEV_SERVER_URL: "" },
});
const failures = [];
const check = (ok, what) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) failures.push(what);
};

try {
  const page = await app.firstWindow();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  await page.waitForSelector("text=Criar uma sala", { timeout: 15000 });
  check(true, "home renderiza");
  check((await page.evaluate(() => location.origin)) === "app://myscreen", "origem app://myscreen");
  await page.screenshot({ path: path.join(out, "home.png") });

  const bridge = await page.evaluate(() => Object.keys(window.myscreen ?? {}).sort().join(","));
  check(bridge === "api,app,audio,bar,capture,room,settings,updates", `ponte window.myscreen (${bridge})`);
  check(await page.evaluate(() => typeof (window).require === "undefined" && typeof (window).process === "undefined"), "renderer sem Node");

  const sources = await page.evaluate(() => window.myscreen.capture.list());
  check(sources.some((s) => s.kind === "screen"), `fontes de captura (${sources.length}, telas: ${sources.filter((s) => s.kind === "screen").length})`);
  check(!sources.some((s) => /MyScreen/.test(s.name) && s.kind === "window"), "janelas do próprio app fora da lista");

  const caps = await page.evaluate(() => window.myscreen.audio.capabilities());
  check(caps.native === true, `som nativo disponível (${caps.reason ?? "ok"})`);

  if (caps.native) {
    // Captura real: abre o som do sistema (exceto o MyScreen) e mede pacotes.
    const result = await page.evaluate(async () => {
      const id = "smoke";
      const got = new Promise((resolve) => {
        window.addEventListener("message", (e) => {
          if (e.data?.type === "myscreen:audio-port" && e.data.id === id) {
            const port = e.ports[0];
            let packets = 0;
            let bytes = 0;
            port.onmessage = (m) => {
              packets++;
              bytes = m.data.byteLength ?? m.data.length;
            };
            port.start();
            setTimeout(() => resolve({ packets, bytes }), 1500);
          }
        });
      });
      const levels = [];
      const off = window.myscreen.audio.onLevel((l) => levels.push(l.level));
      const r = await window.myscreen.audio.start(id, { kind: "system-except-self" }, { normalize: true, gainPct: 100 });
      if (!r.ok) return { error: r.error };
      const g = await got;
      off();
      window.myscreen.audio.stop();
      return { ...g, levels: levels.length };
    });
    check(!result.error, `captura nativa abriu (${result.error ?? "ok"})`);
    // Sem som tocando o Windows pode não entregar nada; o medidor sempre chega.
    check((result.levels ?? 0) > 5, `medidor de nível chegando (${result.levels} leituras, ${result.packets} pacotes de ${result.bytes} bytes)`);
    if (result.packets > 0) check(result.bytes === 1920, "pacote de 10 ms = 1920 bytes");
  }

  // Seletor próprio: a fonte escolhida chega ao getDisplayMedia (com gesto real).
  const screenSource = sources.find((s) => s.kind === "screen");
  await page.evaluate((id) => {
    const b = document.createElement("button");
    b.id = "gdm-test";
    b.textContent = "gdm";
    b.style.cssText = "position:fixed;left:0;bottom:0;z-index:99999;-webkit-app-region:no-drag";
    b.onclick = async () => {
      try {
        await window.myscreen.capture.select(id, { loopbackAudio: false });
        const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60 }, audio: false });
        const t = stream.getVideoTracks()[0];
        window.__gdm = { ok: true, label: t.label, settings: t.getSettings() };
        t.stop();
      } catch (e) {
        window.__gdm = { ok: false, error: `${e.name}: ${e.message}` };
      }
    };
    document.body.append(b);
  }, screenSource.id);
  await page.click("#gdm-test");
  await page.waitForFunction(() => window.__gdm, null, { timeout: 10000 });
  const gdm = await page.evaluate(() => window.__gdm);
  check(gdm.ok, `getDisplayMedia com a fonte escolhida (${gdm.ok ? `${gdm.settings.width}×${gdm.settings.height}` : gdm.error})`);
  const denied = await page.evaluate(async () => {
    try {
      await navigator.mediaDevices.getDisplayMedia({ video: true });
      return false;
    } catch {
      return true;
    }
  });
  check(denied, "getDisplayMedia sem fonte escolhida é negado");
  await page.evaluate(() => document.getElementById("gdm-test")?.remove());

  // Compartilhar não abre mais a barra flutuante.
  await page.evaluate(() =>
    window.myscreen.room.setSharing({ active: true, sourceName: "Tela de teste", displayId: null, hideSelf: true, hasSystemAudio: false }),
  );
  await page.waitForTimeout(800);
  check(!app.windows().some((w) => !w.isClosed() && w.url().includes("sharing-bar")), "sem barra Compartilhando");
  await page.evaluate(() =>
    window.myscreen.room.setSharing({ active: false, sourceName: "", displayId: null, hideSelf: false, hasSystemAudio: false }),
  );

  // "Só esta janela": o PID sai do HWND e a captura abre em modo include.
  const win = sources.find((s) => s.kind === "window");
  if (caps.native && win) {
    const r = await page.evaluate(async (sourceId) => {
      const r = await window.myscreen.audio.start("win", { kind: "window-only", sourceId }, { normalize: true, gainPct: 100 });
      window.myscreen.audio.stop();
      return r;
    }, win.id);
    check(r.ok, `som só da janela "${win.name}" (${r.ok ? "ok" : r.error})`);
  }

  const settings = await page.evaluate(() => window.myscreen.settings.get());
  check(/^https?:\/\//.test(settings.serverUrl), `servidor configurado (${settings.serverUrl})`);
  const bad = await page.evaluate(() => window.myscreen.settings.set({ serverUrl: "http://evil.example" }));
  check(bad.ok === false, "servidor http não-local é recusado");

  // Lobby com câmera falsa (sala efêmera; não depende de o servidor responder).
  await page.fill("#room-code", "https://exemplo/room/smoke-test?x=1");
  // `text-is`: "Criar e entrar" também contém "entrar" e criaria uma sala no servidor.
  await page.click("form button[type=submit]:text-is('Entrar')");
  await page.waitForSelector("text=Lobby pré-reunião", { timeout: 20000 });
  check(true, "lobby abre a partir de um link colado");
  await page.waitForTimeout(2500);
  check(await page.evaluate(() => {
    const v = document.querySelector("video");
    return Boolean(v && v.srcObject && v.srcObject.getVideoTracks().length > 0);
  }), "preview da câmera no lobby");
  await page.screenshot({ path: path.join(out, "lobby.png") });

  check(errors.length === 0, `sem erros no console${errors.length ? `: ${errors.slice(0, 3).join(" | ")}` : ""}`);
} catch (error) {
  console.error(error);
  failures.push(String(error));
} finally {
  await app.close();
}

if (failures.length) {
  console.error(`\n${failures.length} falha(s)`);
  process.exit(1);
}
console.log("\nsmoke ok");
