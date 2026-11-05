import { db, parseJson } from "../db.js";
import { dvdToAired, readEpisodeOrder, orderLinks, episodeOrderError, episodeOrderRevision, assertNoDvdContainer, provenanceOrder } from "./episodeOrder.js";
import { AIRED_ORDER, isAlternateOrder } from "./tvdbOrderTypes.js";
export { assertOrderInsert } from "./episodeOrder.js";
import { getTvdbOrderCatalogue, getCachedTvdbOrderCatalogue } from "./tvdbOrderGateway.js";
import { readShowNumbering } from "./seasonSource.js";
import { resolveEpisodeOrderTargets, resolveSourceOrderEpisode } from "./episodeOrderTargets.js";
import crypto from "node:crypto";
import { loadMediaConfig } from "./configStore.js";

const verifiedOrder = Symbol("verified episode-order dispatch");
const binding = section => crypto.createHash("sha256").update(JSON.stringify([section?.baseUrl,section?.token,section?.apiKey,section?.userId,section?.disabled,section?.sync])).digest("hex");

function provenanceOf(record) {
  const value = record.watch_provenance || record.watchProvenance || {};
  return typeof value === "string" ? parseJson(value) || {} : value;
}
const idOf = record => String(record.tvdb_id || record.tvdbId || record.tvdb || record.ids?.tvdb || "");
const isEpisode = record => String(record.media_type || record.mediaType || record.type || "").toLowerCase() === "episode";
const code = (s,e) => `S${String(s).padStart(2,"0")}E${String(e).padStart(2,"0")}`;

export async function resolveOrderWatch(record, config, { display = false, stateType = /unwatch|unplayed/.test(record.sync_action || record.syncAction || record.phase || "") ? "unwatched" : "watched" } = {}) {
  assertNoDvdContainer(record);
  if (!isEpisode(record)) return record;
  const provenance = provenanceOf(record);
  const identity = provenance.episode_order;
  const tvdbId = idOf(record) || String(identity?.tvdbId || "");
  if (!tvdbId && isAlternateOrder(record.numbering_source)) throw episodeOrderError("A verified TVDB show identity is required. No watched state was changed.");
  if (!tvdbId || (!identity && readEpisodeOrder(tvdbId).order === AIRED_ORDER && !isAlternateOrder(record.numbering_source))) return record;
  if (readShowNumbering(tvdbId).rowNumbering !== "tvdb") throw episodeOrderError("Episode order mapping requires verified local aired episode identities. This show's stored TMDB numbering needs review; nothing was changed.");
  // The order the record is read in: its stored identity, else the order the
  // client displayed it in, else the show's selected order.
  const order = identity ? provenanceOrder(identity) : isAlternateOrder(record.numbering_source) ? record.numbering_source : readEpisodeOrder(tvdbId).order;
  let dvd, aired;
  if (display && isAlternateOrder(record.numbering_source)) ({ dvd, aired } = await dvdToAired(tvdbId, record.season, record.episode, record.numbering_source));
  else {
    const catalogue = await getTvdbOrderCatalogue(tvdbId);
    const links = orderLinks(catalogue, readEpisodeOrder(tvdbId), order);
    if (!identity && (record.id || record.watchRecordId || record.watch_record_id)) throw episodeOrderError("This stored episode has no verified aired identity. No watched state was changed.");
    const sourceAired = !identity ? await resolveSourceOrderEpisode({media:record,config,catalogue}) : null;
    if (identity && String(identity.tvdbId) !== tvdbId) throw episodeOrderError();
    const link = sourceAired ? links.find(m=>m.airedId === sourceAired.id) : links.find(m => m.dvdId === Number(identity.dvdId) && m.airedId === Number(identity.airedId));
    dvd = link && catalogue.orders[order]?.find(e=>e.id === link.dvdId);
    aired = link && catalogue.orders[AIRED_ORDER].find(e=>e.id === link.airedId);
    if (!aired || (identity && (Number(record.season) !== aired.season || Number(record.episode) !== aired.episode))) throw episodeOrderError();
  }
  const resolved = await resolveEpisodeOrderTargets({ aired, media:record, config, stateType });
  // Existing unproven rows at the storage coordinate may mean a different
  // episode under a media server's own order. Never merge or replace those.
  const collisions = db.prepare("SELECT id,source,season,episode,title,tvdb_id,watch_provenance FROM watch_history WHERE media_type='episode' AND tvdb_id=? AND season=? AND episode=?").all(tvdbId, aired.season, aired.episode);
  const catalogue = await getTvdbOrderCatalogue(tvdbId);
  if (collisions.some(row=>Number(provenanceOf(row).episode_order?.airedId) !== aired.id)) throw episodeOrderError("Existing history at this coordinate needs episode identity review. No watched state was changed.");
  return { ...record, tvdb_id:tvdbId, ...(record.ids ? {ids:{...record.ids,tvdb:tvdbId}} : {}), season:aired.season, episode:aired.episode, numbering_source:undefined,
    title:String(record.title || "").replace(/\bS\d+E\d+\b/i, code(aired.season,aired.episode)),
    provider_items:resolved.providerItems, providerItems:resolved.providerItems, provider_item_id:undefined, providerItemId:undefined,
    provider_overrides:resolved.targets.traktOverride ? {trakt:resolved.targets.traktOverride} : undefined,
    traktOverride:resolved.targets.traktOverride,
    watch_provenance:{...provenance, episode_order:{tvdbId,dvdId:dvd.id,airedId:aired.id,order}, ...(resolved.targets.traktOverride ? {provider_overrides:{trakt:resolved.targets.traktOverride}} : {})},
    watchProvenance:{...provenance,episode_order:{tvdbId,dvdId:dvd.id,airedId:aired.id,order}},
    [verifiedOrder]:{at:Date.now(),stateType,revision:episodeOrderRevision(catalogue,readEpisodeOrder(tvdbId)),season:aired.season,episode:aired.episode,items:resolved.providerItems,bindings:Object.fromEntries(["plex","emby","jellyfin"].map(p=>[p,binding(config[p])]))},
  };
}

// Polling, notification and live-session paths build their own media and must
// translate a non-Aired order exactly as the webhook does, before any dedupe or
// playstate lookup: those lookups key on the coordinate, and a native coordinate
// could collide with a different real aired episode. A refusal writes nothing and
// is logged with its reason; the caller skips just this item.
export async function resolveOrderMediaForPolling(media, config, log = console.warn) {
  try {
    // The state follows the media's own phase (unplayed means an unwatch).
    return await resolveOrderWatch(media, config);
  } catch (error) {
    log(`Episode order: skipped "${media?.title || "unknown episode"}" (${media?.source || "unknown source"}); ${error?.message || String(error)}`);
    return null;
  }
}

// Up Next actions are manual, but their coordinates and native item hints came
// from a media server. Verify that episode before the local unwatch lookup or
// insertion, just as we do for a provider event. Keep manual dispatch semantics.
export async function resolveOrderUpNextAction(media, config) {
  if (!isEpisode(media) || readEpisodeOrder(idOf(media)).order === AIRED_ORDER
    || provenanceOf(media).episode_order) return media;
  const items = media.providerItems || media.provider_items || {};
  const provider = ["plex", "emby", "jellyfin"].find(p => {
    const ids = items[p];
    return config?.[p]?.baseUrl && (Array.isArray(ids) ? ids.length : ids);
  });
  if (!provider) throw episodeOrderError("This Up Next episode needs a verified media-server item before it can be removed. No watched state was changed.");
  const resolved = await resolveOrderWatch({ ...media, source: provider }, config, { stateType: "unwatched" });
  // A request-side key still names the displayed/native coordinates. Let local
  // state lookups derive their key from the verified aired identity instead.
  return { ...resolved, source: media.source, media_key: undefined };
}

// Provenance builders replace media.watchProvenance wholesale; this carries the
// verified episode_order identity (and any provider overrides) across, since the
// insert guard refuses a translated row that has lost it.
export function keepOrderProvenance(previous, next) {
  const kept = previous && typeof previous === "object" ? previous : {};
  return {
    ...next,
    ...(kept.episode_order ? { episode_order: kept.episode_order } : {}),
    ...(kept.provider_overrides ? { provider_overrides: kept.provider_overrides } : {}),
  };
}

// Also protects Force Sync and Up Next callers of the low-level adapters.
// This short-lived in-process proof is never serialized into a queue or row.
export async function prepareEpisodeOrderTarget(media, provider, section, stateType) {
  assertNoDvdContainer(media);
  const proof = media[verifiedOrder];
  if (proof && proof.stateType === stateType && Date.now()-proof.at < 10000 && media.season === proof.season && media.episode === proof.episode && media.providerItems === proof.items && media.provider_items === proof.items && proof.bindings[provider] === binding(section) && proof.revision === episodeOrderRevision(getCachedTvdbOrderCatalogue(idOf(media)),readEpisodeOrder(idOf(media)))) return media;
  if (!isEpisode(media) || (!provenanceOf(media).episode_order && readEpisodeOrder(idOf(media)).order === AIRED_ORDER)) return media;
  return resolveOrderWatch(media,{...await loadMediaConfig(),[provider]:section},{stateType});
}

// All mapping checks complete before a batch can enter its mutation loop.
export async function preflightOrderRecords(records, config) {
  const prepared = [];
  for (let record of records) {
    // Manual actions must check every configured destination; a request-side
    // allowlist cannot suppress a mapping check before intents are captured.
    record = {...record,syncTargets:undefined};
    if (isEpisode(record) && !idOf(record) && !isAlternateOrder(record.numbering_source)) {
      const {getKnownShowIdentityForTitle,showTitleFrom} = await import("./dataRepo.js");
      const known = await getKnownShowIdentityForTitle(showTitleFrom(record.title));
      if (known?.tvdb_id && readEpisodeOrder(known.tvdb_id).order !== AIRED_ORDER) {
        if (record.tmdb_id && known.tmdb_id && String(record.tmdb_id) !== String(known.tmdb_id)) throw episodeOrderError();
        record = {...record,tvdb_id:known.tvdb_id};
      }
    }
    prepared.push(await resolveOrderWatch(record, config, {display:true,stateType:"watched"}));
  }
  return prepared;
}
