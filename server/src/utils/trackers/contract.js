// Capabilities describe provider operations, never connection eligibility or
// permission to enqueue work. Shared engines retain those decisions and prove
// preconditions before passing their names in satisfiedPreconditions. This is
// an internal server interface, never a user-supplied authorization payload.
export function freezeTrackerValue(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeTrackerValue);
    Object.freeze(value);
  }
  return value;
}

export function assertTrackerOperation(adapter, operation, { mediaType, trigger, satisfiedPreconditions = [] } = {}) {
  const capability = Object.hasOwn(adapter?.capabilities || {}, operation)
    ? adapter.capabilities[operation] : null;
  if (!capability?.supported || !capability.mediaTypes.includes(mediaType)
      || !capability.triggers.includes(trigger)) {
    throw Object.assign(new Error(`Unsupported tracker operation: ${adapter?.id || "unknown"}/${operation}`), {
      code: "TRACKER_UNSUPPORTED_OPERATION", provider: adapter?.id, operation,
    });
  }
  const missing = capability.preconditions.filter((condition) => !satisfiedPreconditions.includes(condition));
  if (missing.length) {
    throw Object.assign(new Error(`Tracker operation preconditions missing: ${missing.join(", ")}`), {
      code: "TRACKER_PRECONDITION_REQUIRED", provider: adapter.id, operation, missing,
    });
  }
  return capability;
}

export function executeTrackerOperation(adapter, operation, context, ...args) {
  assertTrackerOperation(adapter, operation, context);
  const handler = Object.hasOwn(adapter.operations, operation) ? adapter.operations[operation] : null;
  if (typeof handler !== "function") {
    throw Object.assign(new Error(`Missing tracker operation: ${operation}`), { code: "TRACKER_UNSUPPORTED_OPERATION" });
  }
  return handler(...args);
}
