import { useEffect, useState } from "react";

// Some kiosk webviews on the factory floor never implement onLine; assume
// connected rather than nailing a permanent offline banner to every page.
function readOnline(): boolean {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return true;
  return navigator.onLine;
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(readOnline);

  useEffect(() => {
    const update = () => setOnline(readOnline());
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    // The connection can drop between first render and this effect, so re-read
    // once the listeners are attached.
    update();
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  return online;
}
