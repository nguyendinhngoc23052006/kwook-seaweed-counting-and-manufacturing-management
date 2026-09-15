import { useEffect, useState } from "react";
import type { Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";

interface DeviceRow {
  id: string;
  name: string;
  role: string;
  last_seen_at: string | null;
}

function health(lastSeen: string | null): { label: string; cls: string } {
  if (!lastSeen) return { label: "never seen", cls: "crit" };
  const minutes = (Date.now() - new Date(lastSeen).getTime()) / 60000;
  if (minutes > 10) return { label: `down ${Math.round(minutes)}m`, cls: "crit" };
  if (minutes > 2) return { label: `stale ${Math.round(minutes)}m`, cls: "warn" };
  return { label: "live", cls: "ok" };
}

export default function Wall({ profile }: { profile: Profile }) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);

  useEffect(() => {
    const load = async () => {
      const { data } = await supabase()
        .from("devices")
        .select("id, name, role, last_seen_at")
        .order("name");
      setDevices((data as DeviceRow[]) ?? []);
    };
    void load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="wrap">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ margin: 0 }}>Wall</h1>
        <span className="label">{profile.display_name}</span>
      </div>
      <p className="label">
        Video tiles arrive with the Realtime SFU. Until then this is the fleet health grid.
      </p>
      <div className="grid">
        {devices.map((d) => {
          const h = health(d.last_seen_at);
          return (
            <div className="card" key={d.id}>
              <div className="row" style={{ justifyContent: "space-between" }}>
                <strong>{d.name}</strong>
                <span className={`pill ${h.cls}`}>{h.label}</span>
              </div>
              <div className="label">{d.role}</div>
            </div>
          );
        })}
        {devices.length === 0 ? (
          <div className="card">No devices yet. Create one in Admin.</div>
        ) : null}
      </div>
    </div>
  );
}
