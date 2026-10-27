import { XMLParser, XMLValidator } from "fast-xml-parser";

export const ANIDB_SCHEMA_VERSION = 1;
export const ANIDB_MAX_BYTES = 2 * 1024 * 1024;
const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@", parseTagValue: false,
  parseAttributeValue: false, processEntities: true, maxNestedTags: 32,
  isArray: (_name, path) => ["anime.titles.title", "anime.episodes.episode", "anime.episodes.episode.title"].includes(path),
});

export function anidbError(code) {
  const error = new Error(`AniDB metadata unavailable (${code})`);
  error.code = code;
  return error;
}

export function normalizeAnidbId(value) {
  const id = String(value ?? "").trim();
  if (!/^[1-9]\d{0,9}$/.test(id)) throw anidbError("INVALID_AID");
  return id;
}

const valueOf = (value) => String(value?.["#text"] ?? (typeof value === "string" ? value : "")).trim();
const listOf = (value) => value == null ? [] : Array.isArray(value) ? value : [value];

function titlesOf(value) {
  return listOf(value).map((title) => ({
    language: String(title?.["@xml:lang"] || ""),
    type: String(title?.["@type"] || ""), text: valueOf(title),
  })).filter((title) => title.text);
}

function preferredTitle(titles) {
  return (titles.find((title) => title.language === "en" && title.type === "official")
    || titles.find((title) => title.language === "en" && !["short", "synonym"].includes(title.type))
    || titles.find((title) => title.language === "x-jat" && title.type === "main")
    || titles.find((title) => title.language === "x-jat" && title.type !== "short"))?.text || "";
}

export function parseAnidbAnime(xml, expectedAid) {
  const aid = normalizeAnidbId(expectedAid);
  if (typeof xml !== "string" || Buffer.byteLength(xml, "utf8") > ANIDB_MAX_BYTES) throw anidbError("INVALID_XML");
  // Reject declarations before either validation or parsing. No DTDs/custom
  // entities, external resolution, HTML recovery or entity expansion is allowed.
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(xml) || XMLValidator.validate(xml) !== true) throw anidbError("INVALID_XML");
  let parsed;
  try { parsed = parser.parse(xml); } catch { throw anidbError("INVALID_XML"); }
  if (Object.hasOwn(parsed, "error")) {
    const text = valueOf(parsed.error).toLowerCase();
    throw anidbError(/banned/.test(text) ? "BANNED" : /client|version/.test(text) ? "CLIENT_REJECTED" : "PROVIDER_ERROR");
  }
  const anime = parsed.anime;
  if (!anime || String(anime["@id"]) !== aid) throw anidbError("IDENTITY_MISMATCH");
  const titles = titlesOf(anime.titles?.title);
  const title = preferredTitle(titles);
  if (!title) throw anidbError("MISSING_TITLE");
  return {
    aid, title, titles,
    // Plain text only: strip AniDB URL/label markup and HTML-like tags. Rendering
    // code must still escape this text as it does every other provider field.
    overview: valueOf(anime.description).replace(/https?:\/\/[^\s\[\]]+\s+\[([^\]]+)\]/g, "$1").replace(/<[^>]*>/g, "").replace(/[<>]/g, "").trim(),
    type: valueOf(anime.type),
    episodes: listOf(anime.episodes?.episode).map((episode) => ({
      id: String(episode["@id"] || ""),
      number: valueOf(episode.epno), type: String(episode.epno?.["@type"] || ""),
      titles: titlesOf(episode.title),
    })),
    source: { name: "AniDB", url: `https://anidb.net/anime/${aid}`, license: "CC-BY-NC-SA-4.0" },
  };
}

export async function readAnidbXml(response, signal) {
  // Node fetch decompresses gzip before exposing the body; cap decompressed
  // bytes too, instead of trusting a potentially compressed Content-Length.
  const reader = response.body?.getReader();
  if (!reader) throw anidbError("EMPTY_RESPONSE");
  const chunks = [];
  let size = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    signal?.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > ANIDB_MAX_BYTES) throw anidbError("RESPONSE_TOO_LARGE");
      chunks.push(Buffer.from(value));
    }
    try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)); }
    catch { throw anidbError("INVALID_ENCODING"); }
  } finally {
    signal?.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
