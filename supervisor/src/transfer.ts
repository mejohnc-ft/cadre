import { packBundle, unpackBundle } from "./bundle";
import type { ComputerNames } from "./names";

/**
 * Moving a computer's state in and out, with nothing but `tar` inside it.
 *
 * Both backends can run a command in a computer with stdin and stdout attached, and the image has
 * GNU tar. So export is `tar -cf - -C / workspace` read to the end, import is `tar -xf - -C /`
 * fed the bytes, and neither backend needs a second mechanism. What differs — Docker's exec API
 * against a VM's `container exec` — is the `exec` each backend supplies here.
 */

export type ExecResult = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: string;
};

export type Exec = (
  names: ComputerNames,
  argv: string[],
  stdin?: Uint8Array,
) => Promise<ExecResult>;

async function tarOf(exec: Exec, names: ComputerNames, dir: string) {
  const result = await exec(names, ["tar", "-cf", "-", "-C", "/", dir]);
  if (result.exitCode !== 0) {
    throw new Error(`tar of /${dir} failed: ${result.stderr.trim()}`);
  }
  return result.stdout;
}

export async function exportBundle(
  exec: Exec,
  names: ComputerNames,
): Promise<Uint8Array> {
  const [workspace, profiles] = await Promise.all([
    tarOf(exec, names, "workspace"),
    tarOf(exec, names, "profiles"),
  ]);
  return packBundle({ workspace, profiles });
}

export async function importBundle(
  exec: Exec,
  names: ComputerNames,
  bundle: Uint8Array,
): Promise<void> {
  const entries = unpackBundle(bundle);
  for (const data of [entries.workspace, entries.profiles]) {
    const result = await exec(names, ["tar", "-xf", "-", "-C", "/"], data);
    if (result.exitCode !== 0) {
      throw new Error(`restoring the bundle failed: ${result.stderr.trim()}`);
    }
  }
}
