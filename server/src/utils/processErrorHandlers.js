// A stray promise rejection should not take down the scheduler and webhook
// ingestion with it, so it is logged and the process keeps running. An uncaught
// exception leaves state that cannot be trusted, so it is logged, flushed, and
// the process exits; the container restart policy brings it back.
export function installProcessErrorHandlers({
  proc = process,
  flush = () => {},
  logger = console,
} = {}) {
  proc.on("unhandledRejection", (reason) => {
    logger.error("Unhandled promise rejection (process kept running)", reason);
  });
  proc.on("uncaughtException", (error) => {
    logger.error("Uncaught exception - exiting", error);
    try { flush(); } catch { /* ignore */ }
    proc.exit(1);
  });
}
