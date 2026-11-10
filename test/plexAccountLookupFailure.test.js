import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

// Step 3 of the 10 November 2026 audit: a failed /accounts request was cached as
// "no account" for 60 seconds, and the Home user's read then went out without
// accountID, so Plex answered for the token owner. Now a failed lookup is not
// cached and aborts the account-scoped read; a definite not-found is cached.

makeTempDataDir("plekt-plex-account-lookup-");
const { fetchPlexMetadataItem } = await import("../server/src/utils/plexClient.js");

let accountsMode = "fail"; // "fail" | "found" | "missing"
let requests = [];
const realFetch = globalThis.fetch;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (url) => {
  const parsed = new URL(String(url));
  requests.push(parsed);
  if (parsed.pathname === "/accounts") {
    if (accountsMode === "fail") return new Response("unavailable", { status: 500 });
    const accounts = accountsMode === "found" ? [{ id: 7, name: "alice", title: "alice" }] : [{ id: 9, name: "bob", title: "bob" }];
    return json({ MediaContainer: { Account: accounts } });
  }
  return json({ MediaContainer: { Metadata: [{ ratingKey: "1", type: "movie", title: "Account Scoped", viewCount: 0 }] } });
};
const metadataRequests = () => requests.filter((url) => url.pathname.startsWith("/library/metadata"));
const accountsRequests = () => requests.filter((url) => url.pathname === "/accounts");
test.after(() => { globalThis.fetch = realFetch; });

test("a failed account lookup aborts the Home user's read instead of answering for the token owner", async () => {
  requests = [];
  accountsMode = "fail";
  const config = { baseUrl: "https://plex.example.test", token: "test-token", username: "alice" };

  await assert.rejects(fetchPlexMetadataItem(config, "1"), { code: "PLEX_ACCOUNT_UNRESOLVED" });
  assert.equal(metadataRequests().length, 0, "no account-scoped request may be sent without a resolved id");
});

test("a failed lookup is not cached: the next call resolves the Home user", async () => {
  requests = [];
  accountsMode = "found";
  const config = { baseUrl: "https://plex.example.test", token: "test-token", username: "alice" };

  const item = await fetchPlexMetadataItem(config, "1");
  assert.equal(item?.ratingKey, "1");
  assert.equal(accountsRequests().length, 1, "the earlier failure must not have been remembered");
  assert.equal(metadataRequests()[0].searchParams.get("accountID"), "7");
});

test("a definite not-found is cached, so a missing username does not hammer /accounts", async () => {
  requests = [];
  accountsMode = "missing";
  const config = { baseUrl: "https://plex.example.test", token: "test-token", username: "carol" };

  await assert.rejects(fetchPlexMetadataItem(config, "1"), { code: "PLEX_ACCOUNT_UNRESOLVED" });
  await assert.rejects(fetchPlexMetadataItem(config, "1"), { code: "PLEX_ACCOUNT_UNRESOLVED" });
  assert.equal(accountsRequests().length, 1, "the second call must use the cached not-found");
  assert.equal(metadataRequests().length, 0);
});
