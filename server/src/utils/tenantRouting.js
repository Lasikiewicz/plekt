import { runWithUserContext } from "./userContext.js";
import { findUser, isAdminUserName, resolveActiveTenant } from "./tenancy.js";

// In-process /u/<name>/api/* routing for single-process multi-user mode.
// Rewrites the request path to /api/... and runs dispatch inside that user's
// AsyncLocalStorage context. Never spawns a child process.

function apiPathFromTenantRequest(req) {
  const splat = req.params?.path;
  if (Array.isArray(splat)) {
    const joined = splat.filter(Boolean).join("/");
    return joined ? `/api/${joined}` : "/api";
  }
  if (typeof splat === "string" && splat) return `/api/${splat.replace(/^\/+/, "")}`;
  const original = String(req.originalUrl || req.url || "");
  const match = /^\/u\/[^/]+(\/api(?:\/[^?]*)?)/i.exec(original.split("?")[0] || "");
  return match?.[1] || "/api";
}

export function createTenantApiHandler(dispatch) {
  return function handleTenantApi(req, res) {
    const rawTenant = req.params?.tenant;
    if (!isAdminUserName(rawTenant)) {
      const user = findUser(rawTenant);
      if (user?.stopped && !user.disabled) {
        res.status(503).json({ error: "This user's instance is stopped.", code: "INSTANCE_STOPPED" });
        return;
      }
    }
    const tenant = resolveActiveTenant(rawTenant);
    if (!tenant) {
      res.status(404).json({ error: "Unknown user", code: "TENANT_NOT_FOUND" });
      return;
    }

    const apiPath = apiPathFromTenantRequest(req);
    const search = (() => {
      const original = String(req.originalUrl || req.url || "");
      const index = original.indexOf("?");
      return index >= 0 ? original.slice(index) : "";
    })();

    // Express keeps its own path; give dispatch a rewritten view so routePath
    // strips /api/ the same way as the unprefixed routes.
    const previousPathDescriptor = Object.getOwnPropertyDescriptor(req, "path");
    Object.defineProperty(req, "path", {
      configurable: true,
      enumerable: true,
      writable: true,
      value: apiPath,
    });
    req.url = `${apiPath}${search}`;
    req.plektTenant = tenant.name;

    const restorePath = () => {
      if (previousPathDescriptor) Object.defineProperty(req, "path", previousPathDescriptor);
      else delete req.path;
    };

    return Promise.resolve(runWithUserContext(tenant, () => dispatch(req, res)))
      .finally(restorePath)
      .catch((error) => {
        console.error("Unhandled tenant API error", error);
        if (res.headersSent) return;
        const status = error?.code === "RESTORE_ACTIVE" ? 409 : Number(error?.status);
        if (Number.isInteger(status) && status >= 400 && status < 500) {
          res.status(status).json({
            error: error.message || "Request failed",
            ...(error?.code === "RESTORE_ACTIVE" ? { code: error.code } : {}),
          });
          return;
        }
        res.status(500).json({ error: "Internal error" });
      });
  };
}
