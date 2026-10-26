// Auth inventory is separate from sync activation. Never use it for dispatch.
export const isTrackerAuthProvider = (provider) => ["trakt", "simkl"].includes(provider);
export function assertTrackerAuthProvider(provider) {
  if (!isTrackerAuthProvider(provider)) throw new Error("Unsupported tracker provider");
}
