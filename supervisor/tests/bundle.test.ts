import { describe, expect, test } from "bun:test";
import { packBundle, unpackBundle } from "../src/bundle";

describe("bundle", () => {
  test("round-trips two entries of odd sizes through a ustar archive", () => {
    const workspace = new TextEncoder().encode("w".repeat(1234));
    const profiles = new TextEncoder().encode("p".repeat(777));
    const archive = packBundle({ workspace, profiles });
    // Header + padded data per entry, plus two end blocks.
    expect(archive.byteLength).toBe(512 + 1536 + 512 + 1024 + 1024);
    const back = unpackBundle(archive);
    expect(new TextDecoder().decode(back.workspace)).toBe("w".repeat(1234));
    expect(new TextDecoder().decode(back.profiles)).toBe("p".repeat(777));
  });

  test("is readable by GNU tar", async () => {
    const archive = packBundle({
      workspace: new TextEncoder().encode("workspace bytes"),
      profiles: new TextEncoder().encode("profile bytes"),
    });
    const proc = Bun.spawn(["tar", "-tf", "-"], {
      stdin: "pipe",
      stdout: "pipe",
    });
    proc.stdin.write(archive);
    proc.stdin.end();
    const listing = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(listing.trim().split("\n")).toEqual([
      "workspace.tar",
      "profiles.tar",
    ]);
  });

  test("refuses an archive missing an entry", () => {
    const archive = packBundle({
      workspace: new Uint8Array(1),
      profiles: new Uint8Array(1),
    });
    expect(() => unpackBundle(archive.subarray(0, 1024))).toThrow(/missing/);
  });
});
