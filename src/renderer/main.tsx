import "@fontsource-variable/archivo";
import "@fontsource/spline-sans-mono/400.css";
import "@fontsource/spline-sans-mono/500.css";
import "@fontsource/spline-sans-mono/600.css";
import "./styles/globals.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { bootTheme } from "./lib/theme";
import { desktopPlatform, loadServerUrl, PlatformProvider } from "./platform";

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
