import type { Blob } from "./types";

export interface LineCounterConfig {
  lineY: number;
  beltDy: number;
  gateRadius: number;
  minTrackAge: number;
  maxMissed: number;
}

interface LiveTrack {
  id: number;
  cx: number;
  cy: number;
  prevCy: number;
  age: number;
  missed: number;
  counted: boolean;
}

export interface LineCounterStats {
  created: number;
  counted: number;
  active: number;
  agedOutUncounted: number;
}

export class LineCounter {
  private tracks: LiveTrack[] = [];
  private nextId = 1;
  private created = 0;
  private counted = 0;
  private agedOutUncounted = 0;

  constructor(private config: LineCounterConfig) {}

  update(blobs: Blob[]): number {
    const unmatched = new Set(blobs.keys());
    let newlyCounted = 0;

    for (const track of this.tracks) {
      const predictedY = track.cy + this.config.beltDy;
      let bestIdx = -1;
      let bestDist = this.config.gateRadius;

      for (const i of unmatched) {
        const b = blobs[i] as Blob;
        const d = Math.hypot(b.cx - track.cx, b.cy - predictedY);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }

      if (bestIdx >= 0) {
        const b = blobs[bestIdx] as Blob;
        unmatched.delete(bestIdx);
        track.prevCy = track.cy;
        track.cx = b.cx;
        track.cy = b.cy;
        track.age++;
        track.missed = 0;
      } else {
        track.missed++;
      }
    }

    for (const i of unmatched) {
      const b = blobs[i] as Blob;
      this.tracks.push({
        id: this.nextId++,
        cx: b.cx,
        cy: b.cy,
        prevCy: b.cy,
        age: 1,
        missed: 0,
        counted: false,
      });
      this.created++;
    }

    for (const track of this.tracks) {
      if (track.counted || track.age < this.config.minTrackAge) continue;
      const crossedForward = track.prevCy < this.config.lineY && track.cy >= this.config.lineY;
      if (crossedForward) {
        track.counted = true;
        this.counted++;
        newlyCounted++;
      }
    }

    const survivors: LiveTrack[] = [];
    for (const track of this.tracks) {
      if (track.missed <= this.config.maxMissed) {
        survivors.push(track);
      } else if (!track.counted) {
        this.agedOutUncounted++;
      }
    }
    this.tracks = survivors;

    return newlyCounted;
  }

  // The demo moves the line while running; tracks and counts survive the move so
  // a mid-session nudge does not reset the tally.
  setLineY(lineY: number): void {
    this.config = { ...this.config, lineY };
  }

  // The overlay draws these; the counter itself never needs them back.
  activeTracks(): ReadonlyArray<{ id: number; cx: number; cy: number; counted: boolean }> {
    return this.tracks.map((t) => ({ id: t.id, cx: t.cx, cy: t.cy, counted: t.counted }));
  }

  stats(): LineCounterStats {
    return {
      created: this.created,
      counted: this.counted,
      active: this.tracks.length,
      agedOutUncounted: this.agedOutUncounted,
    };
  }

  reset(): void {
    this.tracks = [];
    this.created = 0;
    this.counted = 0;
    this.agedOutUncounted = 0;
  }
}
