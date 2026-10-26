import { handleAlpha, handleAlphaList as handleList } from "./routes/alpha.js";
import {
  handleBeta,
  handleGamma,
} from "./routes/beta.js?v=1.0";

async function dispatch(req, res) {
  const path = req.path;
  if (path !== "ping") noteActivity();
  if (path === "zeta") return handleBeta(req, res);
  if (path === "alpha" || path === "alpha-old") return handleAlpha(req, res);
  if (/^alpha\/[a-z]+(?:\/status|\/server)?$/i.test(path)) return handleList(req, res, path);
  if (path === "gamma" || path.startsWith("gamma/")) return handleGamma(req, res, path);
  if (["beta/one", "beta/two"].includes(path)) return handleBeta(req, res);
  if (path === "local") return handleLocal(req, res);
  return null;
}

function noteActivity() {}

function handleLocal(req, res) {
  return res;
}

export { dispatch };
