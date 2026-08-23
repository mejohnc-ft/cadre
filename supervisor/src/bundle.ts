/**
 * A computer's portable bundle: its workspace and its browser profile, as one archive.
 *
 * The migration primitive. A bundle is a plain ustar archive with two entries, `workspace.tar` and
 * `profiles.tar`, each itself a tar of the directory rooted at `/` (so `workspace/...` and
 * `profiles/...`). Any backend can produce those two with the tools it has — dockerode's archive
 * API, or `tar` inside a VM — and any backend can restore them the same way, which is what makes
 * "move to server" a copy rather than a conversion.
 *
 * A minimal ustar writer and reader, because two entries do not justify a dependency. Sizes up to
 * 8 GiB per entry, which is the format's limit and well past a browser profile.
 */

export type BundleEntries = { workspace: Uint8Array; profiles: Uint8Array };

const BLOCK = 512;

function header(name: string, size: number): Uint8Array {
  if (size >= 8 ** 11) throw new Error(`${name} is too large for a bundle`);
  const block = new Uint8Array(BLOCK);
  const write = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      block[offset + i] = value.charCodeAt(i);
  };
  write(0, name);
  write(100, "0000644\0");
  write(108, "0000000\0");
  write(116, "0000000\0");
  write(124, `${size.toString(8).padStart(11, "0")}\0`);
  write(
    136,
    `${Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0")}\0`,
  );
  write(148, "        "); // checksum placeholder: eight spaces
  write(156, "0");
  write(257, "ustar\0");
  write(263, "00");
  let sum = 0;
  for (const byte of block) sum += byte;
  write(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  return block;
}

function padded(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

/** A ustar archive of named entries. `packBundle` is the two-entry case; exec's stdin is another. */
export function packTar(
  entries: ReadonlyArray<readonly [string, Uint8Array]>,
): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, data] of entries) {
    parts.push(header(name, data.byteLength));
    parts.push(data);
    parts.push(new Uint8Array(padded(data.byteLength) - data.byteLength));
  }
  parts.push(new Uint8Array(BLOCK * 2)); // end-of-archive
  const total = parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function packBundle(entries: BundleEntries): Uint8Array {
  return packTar([
    ["workspace.tar", entries.workspace],
    ["profiles.tar", entries.profiles],
  ]);
}

export function unpackBundle(archive: Uint8Array): BundleEntries {
  const found: Partial<BundleEntries> = {};
  let offset = 0;
  while (offset + BLOCK <= archive.byteLength) {
    const block = archive.subarray(offset, offset + BLOCK);
    if (block.every((byte) => byte === 0)) break;
    const name = new TextDecoder()
      .decode(block.subarray(0, 100))
      .replace(/\0.*$/, "");
    const size = Number.parseInt(
      new TextDecoder().decode(block.subarray(124, 136)).replace(/\0.*$/, ""),
      8,
    );
    if (!Number.isFinite(size)) throw new Error("Bundle header is not ustar");
    const data = archive.subarray(offset + BLOCK, offset + BLOCK + size);
    if (name === "workspace.tar") found.workspace = data;
    else if (name === "profiles.tar") found.profiles = data;
    offset += BLOCK + padded(size);
  }
  if (!found.workspace || !found.profiles) {
    throw new Error("Bundle is missing workspace.tar or profiles.tar");
  }
  return { workspace: found.workspace, profiles: found.profiles };
}
