/**
 * 1Password on the host, never in the container.
 *
 * The server reads a secret from 1Password with the `op` CLI — biometric-unlocked for a personal
 * account, or a service-account token for an enterprise one — and hands it to the coworker's
 * browser through the same governed type-secret channel every other secret uses. The sandbox has
 * no `op`, no token, and no path to 1Password: it only ever ends up signed in.
 *
 * A reference is an account plus an `op://vault/item` path. Passwords and one-time codes are read
 * per sign-in and never stored in Cadre.
 */

type OpResult = { ok: true; value: string } | { ok: false; error: string };

/** Read one field of a 1Password item. `field` is e.g. "password" or "one-time password". */
async function opRead(
  account: string,
  ref: string,
  field: string,
  serviceAccountToken?: string,
): Promise<OpResult> {
  // op://vault/item + /field. A stray trailing slash on the ref would double up.
  const uri = `${ref.replace(/\/+$/, "")}/${field}`;
  const args = ["read", uri];
  // A personal account resolves by --account; a service account by its token in the env instead.
  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  if (serviceAccountToken) {
    env.OP_SERVICE_ACCOUNT_TOKEN = serviceAccountToken;
  } else if (account) {
    args.push("--account", account);
  }
  try {
    const proc = Bun.spawn(["op", ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0) {
      return { ok: false, error: err.trim() || `op exited ${code}` };
    }
    return { ok: true, value: out.trim() };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The item's password. Throws with op's own message on failure. */
export async function opPassword(
  account: string,
  ref: string,
  serviceAccountToken?: string,
): Promise<string> {
  const result = await opRead(account, ref, "password", serviceAccountToken);
  if (!result.ok) throw new Error(`1Password read failed: ${result.error}`);
  return result.value;
}

/**
 * The item's current one-time code, or null if it has none. `op read` on the OTP field returns the
 * otpauth URI, not the code — so this uses `op item get --otp`, which computes the live 6-digit code.
 * The ref is `op://<vault>/<item>`; the item may be a name or an id.
 */
export async function opOtp(
  account: string,
  ref: string,
  serviceAccountToken?: string,
): Promise<string | null> {
  const match = /^op:\/\/([^/]+)\/([^/]+)/.exec(ref.trim());
  if (!match) return null;
  const [, vault, item] = match;
  const env: Record<string, string> = { ...process.env } as Record<
    string,
    string
  >;
  const args = [
    "item",
    "get",
    item as string,
    "--vault",
    vault as string,
    "--otp",
  ];
  if (serviceAccountToken) {
    env.OP_SERVICE_ACCOUNT_TOKEN = serviceAccountToken;
  } else if (account) {
    args.push("--account", account);
  }
  try {
    const proc = Bun.spawn(["op", ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, code] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ]);
    if (code !== 0) return null;
    const value = out.trim();
    // Guard against an otpauth URI or empty output — a real code is short digits.
    return /^[0-9]{4,10}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

/** The item's username, or null. Not a secret, but convenient to source from the same item. */
export async function opUsername(
  account: string,
  ref: string,
  serviceAccountToken?: string,
): Promise<string | null> {
  const result = await opRead(account, ref, "username", serviceAccountToken);
  if (!result.ok) return null;
  return result.value || null;
}
