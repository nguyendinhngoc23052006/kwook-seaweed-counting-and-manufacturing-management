import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
// The one stylesheet entry: it imports Tailwind, then styles.css into the
// `legacy` cascade layer. Importing styles.css here as well would re-admit it
// un-layered, which is the bug the layer exists to fix.
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found in index.html");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
