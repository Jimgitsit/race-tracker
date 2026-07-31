import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { adoptTokenFromUrl } from "./lib/identity.ts";
import { App } from "./App.tsx";

import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/components.css";
import "./styles/racer.css";
import "./styles/director.css";
import "./styles/display.css";
import "./styles/history.css";

// A re-link QR carries `?t=<token>`; adopt it before React reads identity.
adoptTokenFromUrl();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
