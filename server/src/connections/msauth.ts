/**
 * Microsoft device-code sign-in — the way `az` and Graph PowerShell authenticate.
 *
 * Cadre asks Microsoft for a short code; the person opens https://microsoft.com/devicelogin in
 * their OWN browser, enters it, and signs in normally — clipboard, MFA, conditional access, all
 * of it, because it is a real browser and not a screencast. Microsoft then hands back tokens.
 * The password never touches Cadre or a computer.
 *
 * No app registration is required for a demo: the Microsoft Graph PowerShell public client is a
 * first-party app that supports device code and delegated Graph. A deployment can point at its own
 * registered app by setting the client id / tenant on the connection.
 */

const GRAPH_POWERSHELL_CLIENT = "14d82eec-204b-4c2f-b7e8-296a70dab67e";
const DEFAULT_SCOPE =
  "https://graph.microsoft.com/.default offline_access openid profile";

export type DeviceCodeStart = {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  expiresIn: number;
  interval: number;
  message: string;
};

export type MsTokens = {
  type: "ms-oauth";
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch seconds
  scope: string;
  tenant: string;
  clientId: string;
};

function authBase(tenant: string): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0`;
}

/** Begin device-code sign-in. Returns the code + URL the person uses in their own browser. */
export async function startDeviceCode(options: {
  tenant?: string;
  clientId?: string;
  scope?: string;
  fetchImpl?: typeof fetch;
}): Promise<DeviceCodeStart> {
  const tenant = options.tenant ?? "organizations";
  const clientId = options.clientId ?? GRAPH_POWERSHELL_CLIENT;
  const scope = options.scope ?? DEFAULT_SCOPE;
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(`${authBase(tenant)}/devicecode`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: clientId, scope }).toString(),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof body.device_code !== "string") {
    throw new Error(
      `Device-code start failed: ${body.error_description ?? body.error ?? response.status}`,
    );
  }
  return {
    deviceCode: body.device_code as string,
    userCode: body.user_code as string,
    verificationUri:
      (body.verification_uri as string) ??
      (body.verification_uri_complete as string),
    expiresIn: (body.expires_in as number) ?? 900,
    interval: (body.interval as number) ?? 5,
    message: (body.message as string) ?? "",
  };
}

/**
 * Poll for tokens once. Returns the tokens when the person has finished signing in, `null` while
 * still pending, and throws on a terminal failure (expired, declined).
 */
export async function pollDeviceCode(options: {
  deviceCode: string;
  tenant?: string;
  clientId?: string;
  scope?: string;
  fetchImpl?: typeof fetch;
}): Promise<MsTokens | null> {
  const tenant = options.tenant ?? "organizations";
  const clientId = options.clientId ?? GRAPH_POWERSHELL_CLIENT;
  const doFetch = options.fetchImpl ?? fetch;
  const response = await doFetch(`${authBase(tenant)}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: clientId,
      device_code: options.deviceCode,
    }).toString(),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (response.ok && typeof body.access_token === "string") {
    return {
      type: "ms-oauth",
      accessToken: body.access_token as string,
      refreshToken: (body.refresh_token as string) ?? "",
      expiresAt:
        Math.floor(Date.now() / 1000) + ((body.expires_in as number) ?? 3600),
      scope: (body.scope as string) ?? options.scope ?? DEFAULT_SCOPE,
      tenant,
      clientId,
    };
  }
  // authorization_pending / slow_down mean keep waiting; anything else is terminal.
  if (body.error === "authorization_pending" || body.error === "slow_down") {
    return null;
  }
  throw new Error(
    `Sign-in did not complete: ${body.error_description ?? body.error ?? "unknown error"}`,
  );
}

/** Refresh an access token from the stored refresh token. Returns the new token bundle. */
export async function refreshMsToken(
  tokens: MsTokens,
  fetchImpl: typeof fetch = fetch,
): Promise<MsTokens> {
  const response = await fetchImpl(`${authBase(tokens.tenant)}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: tokens.clientId,
      refresh_token: tokens.refreshToken,
    }).toString(),
  });
  const body = (await response.json()) as Record<string, unknown>;
  if (!response.ok || typeof body.access_token !== "string") {
    throw new Error(
      `Token refresh failed: ${body.error_description ?? body.error ?? response.status}`,
    );
  }
  return {
    ...tokens,
    accessToken: body.access_token as string,
    refreshToken: (body.refresh_token as string) ?? tokens.refreshToken,
    expiresAt:
      Math.floor(Date.now() / 1000) + ((body.expires_in as number) ?? 3600),
  };
}
