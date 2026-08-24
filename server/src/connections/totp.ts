/**
 * RFC 6238 TOTP, so a web login with one-time codes needs no authenticator app in the loop: the
 * seed lives encrypted in the connections vault and the server computes the six digits at the
 * moment they are typed. SHA-1, 30-second step, six digits — the defaults every issuer uses.
 */

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function decodeBase32(seed: string): Uint8Array {
  const clean = seed.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error(`Not a base32 character: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

export async function totpCode(
  seed: string,
  at: Date = new Date(),
  stepSeconds = 30,
  digits = 6,
): Promise<string> {
  const counter = Math.floor(at.getTime() / 1000 / stepSeconds);
  const message = new Uint8Array(8);
  new DataView(message.buffer).setBigUint64(0, BigInt(counter));
  const key = await crypto.subtle.importKey(
    "raw",
    decodeBase32(seed).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, message.buffer as ArrayBuffer),
  );
  const offset = (mac[mac.length - 1] as number) & 0x0f;
  const code =
    (((mac[offset] as number) & 0x7f) << 24) |
    ((mac[offset + 1] as number) << 16) |
    ((mac[offset + 2] as number) << 8) |
    (mac[offset + 3] as number);
  return String(code % 10 ** digits).padStart(digits, "0");
}
