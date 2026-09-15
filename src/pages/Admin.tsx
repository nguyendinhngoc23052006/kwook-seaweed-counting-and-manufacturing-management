import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/errorMessage";
import type { DeviceRole, Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";

interface ProfileRow {
  id: string;
  kind: "device" | "human";
  role: string;
  display_name: string;
}

interface DeviceRow {
  id: string;
  name: string;
  role: string;
  station_id: string | null;
  revoked_at: string | null;
}

interface StationRow {
  id: string;
  name: string;
  kind: string;
}

const DEVICE_ROLES: DeviceRole[] = ["counting", "provisioning", "compliance", "overview"];

export default function Admin({ profile }: { profile: Profile }) {
  const [profiles, setProfiles] = useState<ProfileRow[]>([]);
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [stations, setStations] = useState<StationRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [p, d, s] = await Promise.all([
      supabase().from("profiles").select("id, kind, role, display_name").order("display_name"),
      supabase().from("devices").select("id, name, role, station_id, revoked_at").order("name"),
      supabase().from("stations").select("id, name, kind").order("name"),
    ]);
    setProfiles((p.data as ProfileRow[]) ?? []);
    setDevices((d.data as DeviceRow[]) ?? []);
    setStations((s.data as StationRow[]) ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function makeDevice(row: ProfileRow, role: DeviceRole, stationId: string) {
    setBusy(row.id);
    setError(null);
    try {
      // Order matters: flip the profile first. The devices insert is checked by
      // a policy that does not care about kind, but a devices row pointing at a
      // profile still marked 'human' would read as a device that can also sign
      // in as a person.
      const flip = await supabase()
        .from("profiles")
        .update({ kind: "device", role: "viewer" })
        .eq("id", row.id);
      if (flip.error) throw flip.error;

      const insert = await supabase()
        .from("devices")
        .insert({
          id: row.id,
          tenant_id: profile.tenant_id,
          name: row.display_name,
          role,
          station_id: stationId || null,
        });
      if (insert.error) throw insert.error;

      await load();
    } catch (e: unknown) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function setRevoked(id: string, revoked: boolean) {
    setBusy(id);
    setError(null);
    const { error } = await supabase()
      .from("devices")
      .update({ revoked_at: revoked ? new Date().toISOString() : null })
      .eq("id", id);
    if (error) setError(error.message);
    await load();
    setBusy(null);
  }

  if (profile.role !== "admin") {
    return (
      <div className="wrap">
        <div className="card">Admin access required.</div>
      </div>
    );
  }

  const deviceIds = new Set(devices.map((d) => d.id));
  const candidates = profiles.filter((p) => !deviceIds.has(p.id) && p.id !== profile.id);

  return (
    <div className="wrap">
      <h1>Admin</h1>
      {error ? <div className="card crit">{error}</div> : null}

      <h2>Devices</h2>
      <div className="card">
        {devices.length === 0 ? (
          <p className="label">
            No devices yet. Create a second account in Supabase (Authentication → Users → Add user),
            sign out and in once so its profile exists, then pair it below.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th />
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
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy === d.id}
                      onClick={() => setRevoked(d.id, !d.revoked_at)}
                    >
                      {d.revoked_at ? "Restore" : "Revoke"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>Accounts that can become devices</h2>
      <div className="card">
        {candidates.length === 0 ? (
          <p className="label">No unpaired accounts.</p>
        ) : (
          candidates.map((c) => (
            <Candidate
              key={c.id}
              row={c}
              stations={stations}
              busy={busy === c.id}
              onPair={makeDevice}
            />
          ))
        )}
      </div>
    </div>
  );
}

function Candidate({
  row,
  stations,
  busy,
  onPair,
}: {
  row: ProfileRow;
  stations: StationRow[];
  busy: boolean;
  onPair: (row: ProfileRow, role: DeviceRole, stationId: string) => void;
}) {
  const [role, setRole] = useState<DeviceRole>("counting");
  const [stationId, setStationId] = useState("");

  return (
    <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
      <strong>{row.display_name}</strong>
      <div className="row">
        <select
          id={`role-${row.id}`}
          value={role}
          onChange={(e) => setRole(e.target.value as DeviceRole)}
        >
          {DEVICE_ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select
          id={`station-${row.id}`}
          value={stationId}
          onChange={(e) => setStationId(e.target.value)}
        >
          <option value="">no station</option>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button type="button" disabled={busy} onClick={() => onPair(row, role, stationId)}>
          {busy ? "Pairing…" : "Make device"}
        </button>
      </div>
    </div>
  );
}
