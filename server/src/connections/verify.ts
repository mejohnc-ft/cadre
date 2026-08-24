import type { ActionActor, ComputerGateway } from "../computer/gateway";
import type { SnapshotElement } from "../computer/schema";
import type { ConnectionStore } from "./store";

/**
 * Credential intake's second half: proving the saved sign-in actually signs in.
 *
 * Saving a web login puts a secret in the vault; verifying it walks a granted coworker's browser
 * through the real login — username typed openly, password and one-time code delivered through the
 * secret channel — and records what happened on the connection. The same governed path every
 * workflow uses, so a verification run also warms the computer's browser profile: the cookies it
 * leaves behind are the login future firings ride.
 *
 * The walk is deterministic, not model-driven: find the fields by role and label, fill, submit,
 * look at what came back, one extra round for a one-time-code page. Standard login forms — which
 * is nearly all of them — need nothing smarter, and a site that does can get a taught workflow.
 */

const USERNAME_HINT = /user|e-?mail|login|account|phone/i;
const PASSWORD_HINT = /pass/i;
const CODE_HINT = /code|one.?time|otp|2fa|token|verif|authenticator/i;
const SUBMIT_HINT = /sign.?in|log.?in|continue|submit|next|verify/i;
const FAILURE_HINT =
  /incorrect|invalid|wrong|failed|not match|try again|unable to|denied/i;
const SUCCESS_HINT = /sign.?out|log.?out|dashboard|account|welcome|domains/i;

function textbox(
  elements: SnapshotElement[],
  hint: RegExp,
): SnapshotElement | undefined {
  return elements.find(
    (element) =>
      element.role === "textbox" &&
      (hint.test(element.name ?? "") || hint.test(element.type ?? "")),
  );
}

function submitButton(
  elements: SnapshotElement[],
): SnapshotElement | undefined {
  return elements.find(
    (element) =>
      element.role === "button" && SUBMIT_HINT.test(element.name ?? ""),
  );
}

export type VerifyOutcome = {
  status: "ok" | "failed";
  note: string;
};

export function createConnectionVerifier(input: {
  gateway: ComputerGateway;
  store: ConnectionStore;
}) {
  const { gateway, store } = input;

  async function verify(
    connectionId: string,
    botId: string,
    actor: ActionActor,
  ): Promise<VerifyOutcome> {
    const connection = await store.get(connectionId);
    if (!connection) return { status: "failed", note: "No such connection." };
    if (connection.kind !== "web") {
      return {
        status: "failed",
        note: "Only web logins are verified this way; api connections prove themselves on first use.",
      };
    }
    if (!connection.loginUrl) {
      return { status: "failed", note: "The connection has no sign-in page." };
    }
    if (!connection.grants.includes(botId)) {
      return {
        status: "failed",
        note: `${botId} has no grant for ${connectionId}.`,
      };
    }

    const outcome = await walk(connection.loginUrl, connection, botId, actor);
    await store.recordVerify(connectionId, outcome);
    return outcome;
  }

  async function walk(
    loginUrl: string,
    connection: { id: string; username: string | null; hasTotp: boolean },
    botId: string,
    actor: ActionActor,
  ): Promise<VerifyOutcome> {
    try {
      await gateway.navigate(botId, actor, loginUrl);
      // Two rounds: the sign-in form, then possibly a one-time-code page behind it.
      for (let round = 0; round < 2; round++) {
        const snapshot = await gateway.snapshot(botId);
        const elements = snapshot.elements;
        const password = textbox(elements, PASSWORD_HINT);
        const username = textbox(elements, USERNAME_HINT);
        const code = textbox(elements, CODE_HINT);

        if (password || username) {
          if (username && connection.username) {
            await gateway.type(botId, actor, {
              ref: username.ref,
              snapshotId: snapshot.snapshotId,
              text: connection.username,
            });
          }
          if (password) {
            await gateway.typeSecret(botId, actor, {
              ref: password.ref,
              snapshotId: snapshot.snapshotId,
              connection: connection.id,
              field: "password",
            });
          }
        } else if (code && connection.hasTotp) {
          await gateway.typeSecret(botId, actor, {
            ref: code.ref,
            snapshotId: snapshot.snapshotId,
            connection: connection.id,
            field: "totp",
          });
        } else if (round === 0) {
          return {
            status: "failed",
            note: "No sign-in form was found on the page.",
          };
        } else {
          break;
        }

        const button = submitButton(elements);
        if (button) {
          await gateway.click(botId, actor, {
            ref: button.ref,
            snapshotId: snapshot.snapshotId,
          });
        } else {
          const field = password ?? code ?? username;
          if (field) {
            await gateway.key(botId, actor, {
              ref: field.ref,
              snapshotId: snapshot.snapshotId,
              key: "Enter",
            });
          }
        }
        // The page needs a beat to answer; the read below reflects wherever the submit landed.
        await new Promise((resolve) => setTimeout(resolve, 2_500));

        const after = await gateway.read(botId);
        if (FAILURE_HINT.test(after.text)) {
          return {
            status: "failed",
            note: `The site refused the sign-in: ${firstMatch(after.text, FAILURE_HINT)}`,
          };
        }
        const stillOnLogin = /sign.?in|log.?in/i.test(after.url);
        if (!stillOnLogin || SUCCESS_HINT.test(after.text)) {
          return {
            status: "ok",
            note: `Signed in; landed on ${after.url}`,
          };
        }
        // Still on a sign-in-looking page with no error text: loop once for a code page.
      }
      const last = await gateway.read(botId);
      return {
        status: "failed",
        note: `Still on a sign-in page after submitting: ${last.url}`,
      };
    } catch (error) {
      return {
        status: "failed",
        note: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { verify };
}

function firstMatch(text: string, pattern: RegExp): string {
  const index = text.search(pattern);
  if (index < 0) return "";
  return text
    .slice(Math.max(0, index - 40), index + 80)
    .replace(/\s+/g, " ")
    .trim();
}

export type ConnectionVerifier = ReturnType<typeof createConnectionVerifier>;
