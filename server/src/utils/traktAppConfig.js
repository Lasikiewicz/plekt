const clean = (value) => String(value || "").trim();
const BUNDLED_TRAKT_CLIENT_ID = "pk3W_PRgltYdQwXkWHSSBoRVhZo7Wdd9DZwBy5lbq20";
const BUNDLED_TRAKT_CLIENT_SECRET = "4LcNUdo_D-OnNhYc2Jr5zNTTJwZdAkcELN-rG2Aofe4";

export function getTraktAppConfig(env = process.env) {
  const overrideClientId = clean(env.TRAKT_CLIENT_ID);
  const overrideClientSecret = clean(env.TRAKT_CLIENT_SECRET);
  const incomplete = Boolean(overrideClientId) !== Boolean(overrideClientSecret);
  const overridden = Boolean(overrideClientId && overrideClientSecret);
  return {
    configured: !incomplete,
    incomplete,
    source: overridden ? "environment" : "bundled",
    clientId: overridden ? overrideClientId : BUNDLED_TRAKT_CLIENT_ID,
    clientSecret: overridden ? overrideClientSecret : BUNDLED_TRAKT_CLIENT_SECRET,
  };
}

export function resolveTraktAppCredentials(input = {}, env = process.env) {
  const clientId = clean(input.clientId);
  const clientSecret = clean(input.clientSecret);
  if (clientId || clientSecret) {
    if (!clientId || !clientSecret) throw new Error("Both Trakt Client ID and Client Secret are required for a personal app");
    return { clientId, clientSecret, source: "personal" };
  }

  const configured = getTraktAppConfig(env);
  if (configured.incomplete) throw new Error("Server Trakt app configuration is incomplete");
  if (!configured.configured) throw new Error("The Plekt Trakt app is not configured on this server");
  return { clientId: configured.clientId, clientSecret: configured.clientSecret, source: "server" };
}

export function hydrateTraktAppCredentials(record, env = process.env) {
  if (record?.clientId && record?.clientSecret) return record;
  const credentials = resolveTraktAppCredentials({}, env);
  return { ...record, clientId: credentials.clientId, clientSecret: credentials.clientSecret };
}
