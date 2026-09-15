import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../lib/errorMessage";
import { functionLabel } from "../lib/functionsCatalog";
import type { Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";

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
}

interface PendingRow {
  id: string;
  display_name: string;
}

export default function Admin({ profile }: { profile: Profile }) {
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [stations, setStations] = useState<StationRow[]>([]);
  const [pending, setPending] = useState<PendingRow[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [d, s, p] = await Promise.all([
      supabase().from("devices").select("id, name, role, station_id, revoked_at").order("name"),
      supabase().from("stations").select("id, name").order("name"),
      supabase()
        .from("profiles")
        .select("id, display_name")
        .eq("kind", "human")
        .eq("role", "pending")
        .order("display_name"),
    ]);
    setDevices((d.data as DeviceRow[]) ?? []);
    setStations((s.data as StationRow[]) ?? []);
    setPending((p.data as PendingRow[]) ?? []);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // Unpair keeps every row the camera ever wrote - it only cuts the phone off
  // (revoked_at blocks its writes in the database itself). There is
  // deliberately NO delete: deleting a device would cascade into its history.
  async function setRevoked(id: string, revoked: boolean) {
    setBusy(id);
    setError(null);
    const { error } = await supabase()
      .from("devices")
      .update({ revoked_at: revoked ? new Date().toISOString() : null })
      .eq("id", id);
    if (error) setError(errorMessage(error));
    await load();
    setBusy(null);
  }

  if (profile.role !== "owner") {
    return (
      <div className="wrap">
        <div className="card">Owner access required.</div>
      </div>
    );
  }

  const stationName = (id: string | null) => stations.find((s) => s.id === id)?.name ?? "-";

  return (
    <div className="wrap">
      <div className="row" style={{ justifyContent: "space-between" }}>
        <h1 style={{ margin: 0 }}>Admin</h1>
        <button
          type="button"
          className="secondary"
          onClick={async () => {
            await supabase().auth.signOut();
            window.location.reload();
          }}
        >
          Sign out
        </button>
      </div>
      {error ? <div className="card crit">{error}</div> : null}

      <h2>Cameras</h2>
      <div className="card">
        <p className="label">
          Pair a new camera: open this site on the camera phone, tap "Use this device as a camera",
          then scan its QR here. Unpairing keeps all of a camera's data.
        </p>
        <a href="/scan">
          <button type="button">Scan camera QR</button>
        </a>
        {devices.length === 0 ? (
          <p className="label">No cameras paired yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Function</th>
                <th>Station</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {devices.map((d) => (
                <tr key={d.id}>
                  <td>{d.name}</td>
                  <td>{functionLabel(d.role)}</td>
                  <td>{stationName(d.station_id)}</td>
                  <td className={d.revoked_at ? "crit" : "ok"}>
                    {d.revoked_at ? "unpaired" : "paired"}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy === d.id}
                      onClick={() => setRevoked(d.id, !d.revoked_at)}
                    >
                      {d.revoked_at ? "Re-activate" : "Unpair"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>People waiting for approval</h2>
      <div className="card">
        {pending.length === 0 ? (
          <p className="label">Nobody waiting.</p>
        ) : (
          <>
            {pending.map((p) => (
              <div className="row" key={p.id} style={{ marginBottom: 4 }}>
                <strong>{p.display_name}</strong>
              </div>
            ))}
            <p className="label" style={{ marginBottom: 0 }}>
              Approve in the Supabase dashboard: Table Editor → profiles → set the account's role
              from "pending" to viewer / supervisor / manager / owner.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
