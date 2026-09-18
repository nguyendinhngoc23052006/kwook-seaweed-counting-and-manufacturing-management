import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// index.css (Tailwind + the ported design tokens) loads first so styles.css --
// this app's own existing device/admin design system -- keeps the last word
// in the cascade for every selector the two touch in common.
import "./index.css";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found in index.html");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
