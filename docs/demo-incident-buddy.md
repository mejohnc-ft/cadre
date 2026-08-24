# Demo: Incident Buddy

> Incident Buddy is a **built-in** coworker, not a harness one — so it drives the *governed*
> browser (`computer_navigate`, `computer_snapshot`, `computer_type_secret`), where the gateway
> decides and audits every action and injects vault credentials it never sees. A harness coworker
> would run its own engine in its VM and skip that governed path.

The pitch, in one line: *Rewst sells you flowcharts; this is a governed agent tech —
it signs into the M365 admin center like a person, with credentials it has never
seen and can never read, does the work, writes the ticket, and every click is in
the audit trail.*

## The arc (~10 min)

1. **Meet Incident Buddy** — its profile page: role, model, the connections it
   holds grants for. "This is an employee record, not a workflow."
2. **The credential moment** — Connections page. The M365 admin login is in the
   vault (password + TOTP seed, entered once, shown never again). Click
   **Verify sign-in** with the live screen open: watch it walk email → password →
   code → "Stay signed in?", then flip to the audit trail:
   `connection.secret_typed`, `connection.verified — ok`. Line: *"it just did MFA
   with a password and a seed it cannot read."*
3. **The ticket** — fire the webhook from a terminal, exactly as a PSA or RMM
   would:

   ```bash
   curl -X POST https://<host>/api/hooks/<trigger-id> \
     -H 'X-Cadre-Token: <token>' \
     -H 'content-type: application/json' \
     -d '{
       "ticket": "<ticket URL>",
       "request": "New user onboarding",
       "firstName": "Dana", "lastName": "Reyes",
       "displayName": "Dana Reyes",
       "username": "dana.reyes@<tenant>.onmicrosoft.com",
       "department": "Finance"
     }'
   ```

   Incident Buddy wakes, signs into admin.microsoft.com (cookies already warm
   from the verify), creates the user, then opens the ticket URL and posts a
   work note with what it did and the temporary password location. Watch it
   live on its screen the whole way.
4. **The governance close** — the audit page: one row per click, the trigger
   firing, the secret deliveries. Then revoke the M365 grant and fire the
   webhook again: *refused, audited, instantly.* That's the Rewst-killer slide.

## Prep checklist (do the night before)

- [ ] Use a **test/dev M365 tenant**, never production: a Microsoft 365
      developer tenant or the lab tenant. Global-admin creds for it go in via
      **Connections → Add** (kind: website login, sign-in page
      `https://admin.microsoft.com`, username, password, TOTP seed). Never
      paste creds in chat; the page is the intake.
- [ ] Grant the connection to `incident-buddy`, click **Verify sign-in**, see
      the green badge. This also warms the browser cookies.
- [ ] Ticket side is **URL-driven**: the webhook payload carries the ticket
      URL. Use a test ticket in the real PSA (add its login to the vault the
      same way and verify it), or any ticket-like page for a dry run.
- [ ] Pre-boot the VM (`slice chat incident-buddy "hello"`) so the demo has no
      cold start; `slice doctor` all green.
- [ ] Dry-run the webhook once end-to-end; read the trigger's lastReply.
- [ ] Have the audit page open in a second tab, filtered fresh.

## Fallbacks

- If the model meanders in the admin center, the demo still lands on beats 1,
  2, and 4 — the credential moment and the revocation are deterministic.
- Record the dry run as a screen capture the night before; a recording of the
  real thing beats a live failure.

## Why this kills the flowchart

- Rewst breaks when the API or the flowchart's assumptions change; a coworker
  reads the page in front of it.
- Rewst holds tenant credentials in its cloud; here they never leave your box,
  the agent can't read them, and revocation is one click with an audit trail.
- The next automation is a sentence in a role artifact, not a consulting
  engagement.
