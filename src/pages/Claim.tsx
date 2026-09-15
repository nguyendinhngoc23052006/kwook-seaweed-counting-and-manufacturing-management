import { useEffect, useState } from "react";
import { errorMessage } from "../lib/errorMessage";
import { FUNCTIONS } from "../lib/functionsCatalog";
import type { DeviceRole, Profile } from "../lib/session";
import { supabase } from "../lib/supabaseClient";

interface StationRow {
  id: string;
  name: string;
}

// The admin side of pairing: opened by scanning the QR a waiting camera shows.
// The secret rides the URL fragment (never sent to any server); submitting
// calls the pair-claim Edge Function, which does all privileged work.
export default function Claim({ profile }: { profile: Profile }) {
  const code = window.location.hash.slice(1);
  const [name, setName] = useState("");
  const [func, setFunc] = useState<DeviceRole>("counting");
  const [stationId, setStationId] = useState("");
  const [stations, setStations] = useState<StationRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void supabase()
      .from("stations")
      .select("id, name")
      .order("name")
      .then(({ data }) => setStations((data as StationRow[]) ?? []));
  }, []);

  if (profile.role !== "admin") {
    return (
      <div className="wrap">
        <div className="card">Admin access required to pair cameras.</div>
      </div>
    );
  }
  if (!code || code.length < 32) {
    return (
      <div className="wrap">
        <div className="card crit">
          No pairing code in this link. Scan the QR shown on the camera again.
        </div>
      </div>
    );
  }

  async function claim(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await supabase().functions.invoke("pair-claim", {
      body: { code, name, func, station_id: stationId || null },
    });
    if (error) setError(errorMessage(error));
    else if (data && typeof data === "object" && "error" in data && data.error) {
      setError(String((data as { error: unknown }).error));
    } else setDone(true);
    setBusy(false);
  }

  if (done) {
    return (
      <div className="wrap" style={{ maxWidth: 420 }}>
        <div className="card">
          <h1>Paired</h1>
          <p>
            <strong>{name}</strong> is set up. The camera's screen switches to the counting view by
            itself within a few seconds.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="wrap" style={{ maxWidth: 420 }}>
      <h1>Pair a camera</h1>
      <form className="card" onSubmit={claim}>
        <div className="label">Camera name</div>
        <input
          id="name"
          value={name}
          placeholder="Machine 1"
          onChange={(e) => setName(e.target.value)}
          style={{ width: "100%", marginBottom: 8 }}
        />
        <div className="label">Function</div>
        <select
          id="func"
          value={func}
          onChange={(e) => setFunc(e.target.value as DeviceRole)}
          style={{ width: "100%", marginBottom: 8 }}
        >
          {FUNCTIONS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <div className="label">Station</div>
        <select
          id="station"
          value={stationId}
          onChange={(e) => setStationId(e.target.value)}
          style={{ width: "100%", marginBottom: 12 }}
        >
          <option value="">no station</option>
          {stations.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <button type="submit" disabled={busy || name.trim().length === 0} style={{ width: "100%" }}>
          {busy ? "Pairing…" : "Pair this camera"}
        </button>
        {error ? (
          <p className="crit" style={{ marginBottom: 0 }}>
            {error}
          </p>
        ) : null}
      </form>
    </div>
  );
}
