import "@fontsource-variable/archivo";
import "@fontsource/spline-sans-mono/400.css";
import "@fontsource/spline-sans-mono/500.css";
import "@fontsource/spline-sans-mono/600.css";
import "./styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootTheme } from "./lib/theme";
import { ControlBar } from "./pages/ControlBar";
import { desktopPlatform, loadServerUrl, PlatformProvider } from "./platform";

// A barra do controle remoto é a mesma página, noutra janela e com outro
// preload (sem `window.myscreen`).
if (location.hash === "#/control-bar") {
  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <ControlBar />
    </StrictMode>,
  );
} else {
  bootTheme();
  void loadServerUrl().finally(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <PlatformProvider value={desktopPlatform}>
          <App />
        </PlatformProvider>
      </StrictMode>,
    );
  });
}
