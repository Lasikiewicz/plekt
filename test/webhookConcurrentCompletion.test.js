import test from "node:test";
import assert from "node:assert/strict";
import { makeTempDataDir } from "./helpers.js";

makeTempDataDir("plekt-webhook-concurrent-completion-");

const { handleWebhook } = await import("../server/src/routes/sync.js");
const { AUTH } = await import("../server/src/appConfig.js");

function responseCapture() {
  const response = {
    statusCode: 200,
    headers: {},
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    set(headers) {
      Object.assign(this.headers, headers);
      return this;
    },
    send(body) {
      this.body = JSON.parse(body);
      return this;
    },
  };
  return response;
}

function webhookRequest(body) {
  const headers = {
    "content-type": "application/json",
    "x-plekt-webhook-secret": AUTH.webhookSecret,
  };
  return {
    method: "POST",
    query: {},
    body,
    headers,
    get: (name) => headers[String(name).toLowerCase()] || "",
  };
}

// Two completion events for the same movie arriving at the same moment (for
// example a Jellyfin stop event and a duplicate delivery) must record one watch.
// Each handler checks for an existing record and then inserts one. Without a
// per-item lock both checks can see "no record" before either insert lands.
test("two concurrent completions for one item record a single watch", async () => {
  const tmdb = "concurrent-completion-movie";
  const completion = () => webhookRequest({
    ServerId: "concurrent-completion-server",
    NotificationType: "PlaybackStop",
    PlayedToCompletion: true,
    Item: {
      Type: "Movie",
      Name: "Concurrent Completion Movie",
      ProviderIds: { Tmdb: tmdb },
    },
  });
  const first = responseCapture();
  const second = responseCapture();
  await Promise.all([
    handleWebhook(completion(), first),
    handleWebhook(completion(), second),
  ]);

  const inserted = [first, second].filter((response) => response.body?.inserted === true);
  assert.equal(inserted.length, 1, `expected one insert, got ${JSON.stringify([first.body, second.body])}`);
});
