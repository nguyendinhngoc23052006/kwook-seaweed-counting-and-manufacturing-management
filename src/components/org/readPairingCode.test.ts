import { describe, expect, it } from "vitest";
import { readPairingCode } from "./PairingCodeScanner";

// The QR used to carry a bare code, which meant a phone's own camera app read
// it, showed 64 characters of hex and offered nothing to do with them. It
// carries a link again; this is the contract that keeps both forms working.
const CODE = "a".repeat(64);

describe("readPairingCode", () => {
  it("reads the code out of a scanned pairing link", () => {
    expect(readPairingCode(`https://kwook.example/org/cameras#pair=${CODE}`)).toBe(CODE);
  });

  it("reads a bare code, which is what the in-app scanner used to see", () => {
    expect(readPairingCode(CODE)).toBe(CODE);
  });

  it("tolerates the whitespace a scan or a paste can carry", () => {
    expect(readPairingCode(`  ${CODE}\n`)).toBe(CODE);
  });

  it("ignores another QR that happens to be in frame", () => {
    expect(readPairingCode("https://example.com/menu")).toBeNull();
    expect(readPairingCode("WIFI:S=factory;T=WPA;P=hunter2;;")).toBeNull();
  });

  it("refuses a link whose code is malformed rather than sending it on", () => {
    expect(readPairingCode("https://kwook.example/org/cameras#pair=short")).toBeNull();
    expect(readPairingCode(`https://kwook.example/org/cameras#pair=${"z".repeat(64)}`)).toBeNull();
  });

  it("refuses an empty hash", () => {
    expect(readPairingCode("https://kwook.example/org/cameras#pair=")).toBeNull();
    expect(readPairingCode("")).toBeNull();
  });
});
