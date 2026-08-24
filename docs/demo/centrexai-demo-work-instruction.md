# Work Instruction — Onboard a CentrexAI demo user and send encrypted credentials

You are Incident Buddy. Perform this end to end in your own governed browser. Verify each step
before moving on. If a step is refused by the boundaries, stop and report exactly which step and why
— do not route around a refusal. Never type or guess a password yourself; sign in only via the vault.

## Inputs (defaults for the demo; a ticket may override)
- Connection for sign-in: `m365-admin`
- New user standard:
  - First name: Demo
  - Last name: CentrexAI
  - Display name: Demo CentrexAI
  - Username (the part before @): `cai.demo` — pick the tenant's default `*.onmicrosoft.com` domain
    from the domain dropdown
  - Usage location: United States
  - Password: let Microsoft auto-generate it, and require a change at first sign-in
  - Licensing/groups: none (a basic standard account)
- Notify: JChristensen@centrexit.com, as an encrypted email

## Steps
1. **Sign in.** Use `computer_use_session` with connection `m365-admin` and open
   `https://admin.microsoft.com`. If that reports no captured session, stop and report that the
   connection has not been connected yet. Confirm you are in the admin center (you can see the left
   navigation) before continuing.
2. **Open Add user.** Go to Users → Active users → "Add a user".
3. **Fill the standard.** Enter the display name, the username with the tenant's default domain,
   set the usage location to United States, choose "Auto-generate password", and leave "Require this
   user to change their password when they first sign in" checked. Assign no license/groups (basic).
4. **Finish and read back.** Complete the wizard. On the final screen Microsoft shows the new user's
   sign-in name and the temporary password — **copy both exactly**. Then confirm the account appears
   in Active users (search for `cai.demo`). Do not report success until you have seen the account.
5. **Compose the notification.** Open Outlook on the web at `https://outlook.office.com/mail/`.
   Click "New mail". To: `JChristensen@centrexit.com`. Subject: `CentrexAI demo user — credentials`.
   Body:
   - Display name and full sign-in name (UPN) of the new user
   - The temporary password
   - A line: "This password must be changed at first sign-in."
6. **Encrypt the email.** Before sending, apply encryption: in the compose window use Options →
   Encrypt (or the "Encrypt" button), choosing "Encrypt" (or "Encrypt-Only"). Confirm the banner
   shows the message is encrypted.
7. **Send.** Send the email. Confirm it left the Drafts/appears in Sent.
8. **Report.** Summarize: the user you created (display name + UPN), that a temporary password was
   set and requires change at first sign-in, that the credentials were sent encrypted to
   JChristensen@centrexit.com, and anything a human still needs to do. Do not put the temporary
   password in your report — say it was sent in the encrypted email.

## Rules
- One sign-in only, via the vault session. No password typed by you.
- Verify before you report each result (account exists; email encrypted; email sent).
- If encryption is unavailable (no license/entitlement), do NOT send an unencrypted email with the
  password — stop and report that encryption was unavailable so a human can decide.
