export const ALPHA_LIMIT = 1;

function privateHelper() {
  return ALPHA_LIMIT;
}

export async function handleAlpha() {
  return privateHelper();
}

export function handleAlphaList() {}
