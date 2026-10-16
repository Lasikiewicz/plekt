// Shared fail-closed validation for complete rating snapshots.
export function ratingSnapshotPage(data, start, pageSize, provider) {
  const page = data?.Items;
  const total = data?.TotalRecordCount;
  if (!Array.isArray(page) || !Number.isInteger(total) || total < 0
      || start + page.length > total || (page.length < pageSize && start + page.length < total)) {
    throw new Error(`${provider} rating snapshot is malformed or incomplete`);
  }
  return page;
}

export function ratingSnapshotArray(value, provider, { empty = false } = {}) {
  if (value == null && empty) return [];
  if (!Array.isArray(value)) throw new Error(`${provider} rating snapshot is malformed or incomplete`);
  return value;
}

export function plexRatingSnapshotPage(container, start, pageSize) {
  const page = ratingSnapshotArray(container?.Metadata, "Plex", { empty: container?.size === 0 || container?.totalSize === 0 });
  const total = container?.totalSize;
  if (total != null && (!Number.isInteger(total) || total < start + page.length
      || (page.length < pageSize && start + page.length < total))) {
    throw new Error("Plex rating snapshot is incomplete");
  }
  return page;
}
