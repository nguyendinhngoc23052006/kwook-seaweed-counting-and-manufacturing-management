import { useEffect, useState } from "react";
import type { Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";

interface DeviceRow {
  id: string;
  name: string;
  role: string;
  station_id: string | null;
  revoked_at: string | null;
}

export default function Admin({ profile }: { profile: Profile }) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);

  useEffect(() => {
    void supabase()
      .from("devices")
      .select("id, name, role, station_id, revoked_at")
      .order("name")
      .then(({ data }) => setDevices((data as DeviceRow[]) ?? []));
  }, []);

  if (profile.role !== "admin") {
    return (
      <div className="wrap">
        <div className="card">Admin access required.</div>
      </div>
    );
  }

  return (
    <div className="wrap">
      <h1>Devices</h1>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {devices.map((d) => (
              <tr key={d.id}>
                <td>{d.name}</td>
                <td>{d.role}</td>
                <td className={d.revoked_at ? "crit" : "ok"}>
                  {d.revoked_at ? "revoked" : "active"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {devices.length === 0 ? <p className="label">No devices yet.</p> : null}
      </div>
    </div>
  );
}
