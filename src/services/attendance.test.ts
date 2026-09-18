import { describe, expect, it } from "vitest";
import { type AttendanceRow, attendanceRowsToCsv } from "./attendance";

function row(overrides: Partial<AttendanceRow> = {}): AttendanceRow {
  return {
    person_id: "p1",
    full_name: "Nguyen Van A",
    employee_code: "E001",
    day: "2026-09-18",
    first_in: "2026-09-18T01:00:00Z",
    last_out: "2026-09-18T09:00:00Z",
    seconds_on_site: 28800,
    check_ins: 1,
    check_outs: 1,
    unpaired_ins: 0,
    unpaired_outs: 0,
    ...overrides,
  };
}

describe("attendanceRowsToCsv", () => {
  it("starts with a UTF-8 BOM so Excel opens Vietnamese names correctly", () => {
    const csv = attendanceRowsToCsv([row()]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
  });

  it("writes the header row", () => {
    const csv = attendanceRowsToCsv([]);
    const header = csv.slice(1);
    expect(header).toBe(
      "person_id,full_name,employee_code,day,first_in,last_out,hours_on_site,check_ins,check_outs,unpaired_ins,unpaired_outs",
    );
  });

  it("gives header only for empty rows", () => {
    const csv = attendanceRowsToCsv([]);
    expect(csv.slice(1).split("\r\n")).toHaveLength(1);
  });

  it("quotes a name containing a comma", () => {
    const csv = attendanceRowsToCsv([row({ full_name: "Nguyen, Van A" })]);
    expect(csv).toContain('"Nguyen, Van A"');
  });

  it("doubles inner quotes when quoting a field", () => {
    const csv = attendanceRowsToCsv([row({ full_name: 'Nguyen "Van" A' })]);
    expect(csv).toContain('"Nguyen ""Van"" A"');
  });

  it("quotes a field containing a newline", () => {
    const csv = attendanceRowsToCsv([row({ full_name: "Nguyen\nVan A" })]);
    expect(csv).toContain('"Nguyen\nVan A"');
  });

  it("formats hours_on_site as seconds_on_site / 3600 with 2 decimals", () => {
    const csv = attendanceRowsToCsv([row({ seconds_on_site: 5400 })]);
    const dataLine = csv.slice(1).split("\r\n")[1];
    expect(dataLine).toContain(",1.50,");
  });

  it("joins lines with \\r\\n", () => {
    const csv = attendanceRowsToCsv([row(), row({ person_id: "p2" })]);
    const lines = csv.slice(1).split("\r\n");
    expect(lines).toHaveLength(3);
  });

  it("writes empty strings for missing first_in / last_out", () => {
    const csv = attendanceRowsToCsv([row({ first_in: null, last_out: null })]);
    const dataLine = csv.slice(1).split("\r\n")[1];
    expect(dataLine).toBe("p1,Nguyen Van A,E001,2026-09-18,,,8.00,1,1,0,0");
  });
});
