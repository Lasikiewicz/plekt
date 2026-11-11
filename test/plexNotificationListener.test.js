import test from "node:test";
import assert from "node:assert/strict";
import { parsePlexNotificationRatingKeys, createPlexNotificationListener } from "../server/src/utils/plexNotificationListener.js";

test("parsePlexNotificationRatingKeys extracts rating keys from single object TimelineEntry", () => {
  const singlePayload = JSON.stringify({
    NotificationContainer: {
      type: "timeline",
      size: 1,
      TimelineEntry: {
        identifier: "com.plexapp.plugins.library",
        itemID: "12345",
        type: 1, // Movie
      },
    },
  });

  const keys = parsePlexNotificationRatingKeys(singlePayload);
  assert.deepEqual(keys, ["12345"]);
});

test("parsePlexNotificationRatingKeys extracts rating keys from array TimelineEntry", () => {
  const arrayPayload = JSON.stringify({
    NotificationContainer: {
      type: "timeline",
      size: 2,
      TimelineEntry: [
        {
          identifier: "com.plexapp.plugins.library",
          itemID: "101",
          type: 1,
        },
        {
          identifier: "com.plexapp.plugins.library",
          ratingKey: "202",
          type: 4, // Episode
        },
      ],
    },
  });

  const keys = parsePlexNotificationRatingKeys(arrayPayload);
  assert.deepEqual(keys, ["101", "202"]);
});

test("parsePlexNotificationRatingKeys ignores bulk library refresh activity", () => {
  const activityPayload = JSON.stringify({
    NotificationContainer: {
      type: "activity",
      size: 1,
      ActivityNotification: [
        {
          event: "updated",
          uuid: "fb444864-fae6-4de0-b5f0-bc4f072e6df0",
          Activity: {
            uuid: "fb444864-fae6-4de0-b5f0-bc4f072e6df0",
            type: "library.refresh.items",
            cancellable: false,
            userID: 1,
            title: "Refreshing",
            subtitle: "Checking files",
            progress: 0,
            Context: { key: "/library/metadata/38800" },
          },
        },
      ],
    },
  });

  const keys = parsePlexNotificationRatingKeys(activityPayload);
  assert.deepEqual(keys, []);
});

test("parsePlexNotificationRatingKeys takes the item from the ended library.refresh.items activity a client's watched toggle produces", () => {
  const frame = (event, type = "library.refresh.items", key = "/library/metadata/6501") => JSON.stringify({
    NotificationContainer: {
      type: "activity",
      size: 1,
      ActivityNotification: [
        { event, uuid: "ec939786", Activity: { uuid: "ec939786", type, title: "Refreshing", Context: { key } } },
      ],
    },
  });

  assert.deepEqual(parsePlexNotificationRatingKeys(frame("ended")), ["6501"]);
  // The started/updated frames repeat the same key, and other activity types are not item changes.
  assert.deepEqual(parsePlexNotificationRatingKeys(frame("started")), []);
  assert.deepEqual(parsePlexNotificationRatingKeys(frame("ended", "library.update.section")), []);
  // Only an item metadata path is a ratingKey; a section or children path is not.
  assert.deepEqual(parsePlexNotificationRatingKeys(frame("ended", "library.refresh.items", "/library/sections/2")), []);
  assert.deepEqual(parsePlexNotificationRatingKeys(frame("ended", "library.refresh.items", "/library/metadata/6496/children")), []);
});

test("parsePlexNotificationRatingKeys includes show and season containers for bulk watch-state changes", () => {
  const containerPayload = JSON.stringify({
    NotificationContainer: {
      type: "timeline",
      TimelineEntry: [
        {
          identifier: "com.plexapp.plugins.library",
          itemID: "998",
          type: 2, // Show container
        },
        {
          identifier: "com.plexapp.plugins.library",
          itemID: "999",
          type: 3, // Season container
        },
      ],
    },
  });

  const keys = parsePlexNotificationRatingKeys(containerPayload);
  assert.deepEqual(keys, ["998", "999"]);
});

test("parsePlexNotificationRatingKeys ignores timeline entries outside supported watch-state types", () => {
  const payload = JSON.stringify({
    NotificationContainer: {
      type: "timeline",
      TimelineEntry: {
        identifier: "com.plexapp.plugins.library",
        itemID: "1000",
        type: 5,
      },
    },
  });

  assert.deepEqual(parsePlexNotificationRatingKeys(payload), []);
});

test("the listener rate-limits item refresh activity so a bulk metadata refresh cannot flood the handler", async () => {
  const activityFrame = (id) => JSON.stringify({
    NotificationContainer: {
      type: "activity",
      size: 1,
      ActivityNotification: [{ event: "ended", Activity: { type: "library.refresh.items", Context: { key: `/library/metadata/${id}` } } }],
    },
  });
  const timelineFrame = (id) => JSON.stringify({
    NotificationContainer: { type: "timeline", size: 1, TimelineEntry: [{ identifier: "com.plexapp.plugins.library", itemID: id, type: 4 }] },
  });

  const handled = [];
  const logs = [];
  let socket;
  const listener = createPlexNotificationListener({
    getPlexConfig: async () => ({ baseUrl: "http://127.0.0.1:32400", token: "t" }),
    onLibraryItemChange: async (ratingKey) => { handled.push(ratingKey); },
    logger: (message) => logs.push(message),
    socketFactory: () => (socket = { close() {} }),
  });
  listener.start();
  await new Promise((resolve) => setTimeout(resolve, 20));

  for (let id = 1; id <= 80; id++) socket.onmessage({ data: activityFrame(id) });
  // A timeline entry is never limited, even in the middle of an activity burst.
  socket.onmessage({ data: timelineFrame("9000") });
  await new Promise((resolve) => setTimeout(resolve, 2700 + 200));
  listener.stop();

  const activityHandled = handled.filter((key) => key !== "9000");
  assert.equal(activityHandled.length, 50, "only the first 50 item refreshes in the window are handled");
  assert.ok(handled.includes("9000"));
  assert.equal(logs.filter((line) => /bulk metadata refresh/.test(line)).length, 1, "the burst is logged once");
});
