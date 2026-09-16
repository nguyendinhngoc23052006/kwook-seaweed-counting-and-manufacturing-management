import { describe, expect, it } from "vitest";
import { coverage, type MinuteRow, perMinuteSeries, ratePerHour, totalFor } from "./counts";

function row(minute: string, count: number, deviceId = "dev-a"): MinuteRow {
  return {
    minute,
    count,
    device_id: deviceId,
    achieved_fps: 12,
    tracks_created: count + 2,
    tracks_counted: count,
  };
}

describe("totalFor", () => {
  it("is zero for no rows", () => {
    expect(totalFor([])).toBe(0);
  });

  it("sums every camera's row, including two cameras on the same minute", () => {
    expect(
      totalFor([
        row("2026-09-16T08:00:00Z", 30),
        row("2026-09-16T08:00:00Z", 12, "dev-b"),
        row("2026-09-16T08:01:00Z", 40),
      ]),
    ).toBe(82);
  });
});

describe("perMinuteSeries", () => {
  it("returns nothing for an empty window", () => {
    expect(perMinuteSeries([], "2026-09-16T08:05:00Z", "2026-09-16T08:00:00Z")).toEqual([]);
  });

  it("returns one point for a single-minute window", () => {
    expect(
      perMinuteSeries(
        [row("2026-09-16T08:00:00Z", 7)],
        "2026-09-16T08:00:00Z",
        "2026-09-16T08:00:00Z",
      ),
    ).toEqual([{ minute: "2026-09-16T08:00:00.000Z", count: 7 }]);
  });

  it("emits a zero for every minute in the window when there are no rows at all", () => {
    const series = perMinuteSeries([], "2026-09-16T08:00:00Z", "2026-09-16T08:04:00Z");
    expect(series).toHaveLength(5);
    expect(series.every((p) => p.count === 0)).toBe(true);
  });

  it("fills a gap with zero so a dead camera is a trough, not a shorter line", () => {
    const series = perMinuteSeries(
      [
        row("2026-09-16T08:00:00Z", 30),
        // 08:01 and 08:02 never arrived - the camera was down.
        row("2026-09-16T08:03:00Z", 25),
      ],
      "2026-09-16T08:00:00Z",
      "2026-09-16T08:03:00Z",
    );
    expect(series.map((p) => p.count)).toEqual([30, 0, 0, 25]);
  });

  it("sums cameras within a minute and drops rows outside the window", () => {
    const series = perMinuteSeries(
      [
        row("2026-09-16T07:59:00Z", 999),
        row("2026-09-16T08:00:00Z", 10),
        row("2026-09-16T08:00:41Z", 5, "dev-b"),
        row("2026-09-16T08:02:00Z", 888),
      ],
      "2026-09-16T08:00:00Z",
      "2026-09-16T08:01:00Z",
    );
    expect(series).toEqual([
      { minute: "2026-09-16T08:00:00.000Z", count: 15 },
      { minute: "2026-09-16T08:01:00.000Z", count: 0 },
    ]);
  });
});

describe("ratePerHour", () => {
  it("is zero for no rows", () => {
    expect(ratePerHour([])).toBe(0);
  });

  it("extrapolates from the minutes covered, not from the window", () => {
    // 60 leaves over 2 reported minutes is 1800/h, however long the shift was.
    expect(ratePerHour([row("2026-09-16T08:00:00Z", 30), row("2026-09-16T08:30:00Z", 30)])).toBe(
      1800,
    );
  });

  it("counts a minute once when two cameras both reported it", () => {
    expect(
      ratePerHour([row("2026-09-16T08:00:00Z", 30), row("2026-09-16T08:00:00Z", 30, "dev-b")]),
    ).toBe(3600);
  });
});

describe("coverage", () => {
  it("is zero for no rows and for a nonsense window", () => {
    expect(coverage([], 60)).toBe(0);
    expect(coverage([row("2026-09-16T08:00:00Z", 5)], 0)).toBe(0);
  });

  it("reports the share of expected minutes that arrived", () => {
    const rows = [
      row("2026-09-16T08:00:00Z", 30),
      row("2026-09-16T08:01:00Z", 0),
      row("2026-09-16T08:02:00Z", 22),
      // 08:03 and 08:04 missing.
    ];
    expect(coverage(rows, 5)).toBe(0.6);
  });

  it("counts a reported zero as covered - silence and nothing are different", () => {
    expect(coverage([row("2026-09-16T08:00:00Z", 0)], 1)).toBe(1);
  });

  it("clamps to 1 when more minutes reported than expected", () => {
    const rows = [row("2026-09-16T08:00:00Z", 1), row("2026-09-16T08:01:00Z", 1)];
    expect(coverage(rows, 1)).toBe(1);
  });
});
