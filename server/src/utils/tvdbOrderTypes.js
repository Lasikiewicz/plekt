// TVDB season types Plekt can read as an episode order. "official" is Aired
// order, the identity every other order is translated to. The rest are the
// alternate orders TVDB lists at /seasons/types.
export const AIRED_ORDER = "official";
export const ALTERNATE_ORDERS = Object.freeze(["dvd", "absolute", "alternate", "regional", "altdvd", "alttwo"]);
export const ORDER_TYPES = Object.freeze([AIRED_ORDER, ...ALTERNATE_ORDERS]);

export const isAlternateOrder = (value) => ALTERNATE_ORDERS.includes(value);

// Fallback names; TVDB's own name for the show's order (for example
// "Parts Order (Netflix)") is used when the catalogue has one.
export const ORDER_NAMES = Object.freeze({
  official: "Aired order", dvd: "DVD order", absolute: "Absolute order", alternate: "Alternate order",
  regional: "Regional order", altdvd: "Alternate DVD order", alttwo: "Alternate order 2",
});
