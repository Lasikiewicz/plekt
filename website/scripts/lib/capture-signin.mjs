// Sign-in for the capture tool. Environment variables win; otherwise the gitignored
// .claude/local-environment.md supplies `- Username = <name>` and `- Password = <value>`.
// Only the first whitespace-free token counts, so a note after the value ("admin (lowercase)")
// never becomes part of it. Values are returned, never printed.
import fs from "node:fs/promises";

export function parseLocalEnvironment(text) {
  const pick = (label) => {
    const match = text.match(new RegExp(`^\\s*-\\s*${label}\\s*=\\s*(\\S+)`, "mi"));
    return match ? match[1] : null;
  };
  return { user: pick("Username"), password: pick("Password") };
}

export async function loadSignIn({ env = process.env, localEnvironmentFile } = {}) {
  if (env.PLEKT_USER && env.PLEKT_PASSWORD) {
    return { user: env.PLEKT_USER, password: env.PLEKT_PASSWORD, source: "PLEKT_USER/PLEKT_PASSWORD" };
  }
  let text;
  try {
    text = await fs.readFile(localEnvironmentFile, "utf8");
  } catch {
    throw new Error(`No sign-in: PLEKT_USER/PLEKT_PASSWORD are not both set and ${localEnvironmentFile} cannot be read.`);
  }
  const { user, password } = parseLocalEnvironment(text);
  if (!user || !password) {
    throw new Error(`No sign-in: ${localEnvironmentFile} has no "- Username = ..." and "- Password = ..." lines.`);
  }
  return { user, password, source: localEnvironmentFile };
}
