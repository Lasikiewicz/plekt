#!/usr/bin/env python3
"""Build Plekt's bundled Netflix catalogue from official What We Watched reports.

The parser intentionally uses only the Python standard library. Run this script from
any directory; downloaded workbooks are cached outside the repository by default.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from xml.etree import ElementTree


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "server" / "resources" / "netflix-catalogue.json"
SOURCES = [
    {
        "period": "2026H1",
        "url": "https://about.netflix.com/en/news/what-we-watched-the-first-half-of-2026",
        "downloadUrl": "https://assets.ctfassets.net/4cd45et68cgf/40WGcHJa9vRua31kU6Gbz5/43b15c7fbd6924392fc80e885839e39f/Netflix-s_What_We_Watched_Report_2026Jan-Jun__1_.xlsx",
    },
    {
        "period": "2025H2",
        "url": "https://about.netflix.com/en/news/what-we-watched-the-second-half-of-2025",
        "downloadUrl": "https://assets.ctfassets.net/4cd45et68cgf/2vdDPGLKA0XX2cjF2APJFn/7f1c367b39ed73a6a588751d3c5d0252/What_We_Watched_A_Netflix_Engagement_Report_2025Jul-Dec__6_.xlsx",
    },
    {
        "period": "2025H1",
        "url": "https://about.netflix.com/en/news/what-we-watched-the-first-half-of-2025",
        "downloadUrl": "https://assets.ctfassets.net/4cd45et68cgf/mplcXj5ulHDfbCPCr0f0I/5dbb6ec09f03df89706476e380e9b8bd/What_We_Watched_A_Netflix_Engagement_Report_2025Jan-Jun.xlsx",
    },
    {
        "period": "2024H2",
        "url": "https://about.netflix.com/en/news/what-we-watched-the-second-half-of-2024",
        "downloadUrl": "https://assets.ctfassets.net/4cd45et68cgf/6XSmoEjBjVMPRtYybT9d1E/8c0b0b2645b8712d5597b0bdbe0d64e2/What_We_Watched_A_Netflix_Engagement_Report_2024Jul-Dec.xlsx",
    },
    {
        "period": "2023H2",
        "url": "https://about.netflix.com/en/news/what-we-watched-the-second-half-of-2023",
        "downloadUrl": "https://assets.ctfassets.net/4cd45et68cgf/inuAnzotdsAEgbInGLzH5/1be323ba419b2af3a96bffa29acc31a3/What_We_Watched_A_Netflix_Engagement_Report_2023Jul-Dec.xlsx",
    },
    {
        "period": "2023H1",
        "url": "https://about.netflix.com/en/news/what-we-watched-the-first-half-of-2023",
        "downloadUrl": "https://assets.ctfassets.net/4cd45et68cgf/1HyknFM84ISQpeua6TjM7A/97a0a393098937a8f29c9d29c48dbfa8/What_We_Watched_A_Netflix_Engagement_Report_2023Jan-Jun.xlsx",
    },
]

NS_MAIN = "http://schemas.openxmlformats.org/spreadsheetml/2006/main"
NS_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
NS_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
TERMINAL_SEASON = re.compile(
    r"\s*:\s*(?:(?:season|series|part|volume)\s+\d+|limited\s+series)\s*$",
    re.IGNORECASE,
)
HEADER_MARKERS = {"title", "titles", "name", "content"}
AGGREGATE_TITLES = {"other shows", "other movies"}
FOOTNOTE_PREFIXES = ("note:", "notes:", "source:", "*", "†", "‡")


def _tag(name: str) -> str:
    return f"{{{NS_MAIN}}}{name}"


def _column_number(reference: str) -> int:
    letters = re.match(r"[A-Z]+", reference.upper())
    if not letters:
        return 0
    number = 0
    for char in letters.group(0):
        number = number * 26 + ord(char) - 64
    return number - 1


def _shared_strings(archive: zipfile.ZipFile) -> list[str]:
    try:
        root = ElementTree.fromstring(archive.read("xl/sharedStrings.xml"))
    except KeyError:
        return []
    return ["".join(text.text or "" for text in item.iter(_tag("t"))) for item in root.iter(_tag("si"))]


def _workbook_sheets(archive: zipfile.ZipFile) -> list[tuple[str, str]]:
    workbook = ElementTree.fromstring(archive.read("xl/workbook.xml"))
    rels = ElementTree.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
    relation_targets = {
        relation.attrib["Id"]: relation.attrib["Target"]
        for relation in rels.findall(f"{{{NS_PKG_REL}}}Relationship")
    }
    sheets = []
    for sheet in workbook.iter(_tag("sheet")):
        rel_id = sheet.attrib.get(f"{{{NS_REL}}}id")
        target = relation_targets.get(rel_id)
        if not target:
            continue
        if target.startswith("/"):
            path = target.lstrip("/")
        else:
            path = os.path.normpath(os.path.join("xl", target)).replace("\\", "/")
        sheets.append((sheet.attrib.get("name", ""), path))
    return sheets


def _cell_value(cell: ElementTree.Element, shared: list[str]) -> str:
    value = cell.find(_tag("v"))
    cell_type = cell.attrib.get("t")
    if cell_type == "inlineStr":
        return "".join(text.text or "" for text in cell.iter(_tag("t")))
    if value is None or value.text is None:
        return ""
    if cell_type == "s":
        try:
            return shared[int(value.text)]
        except (ValueError, IndexError):
            return ""
    return value.text


def _sheet_rows(archive: zipfile.ZipFile, path: str, shared: list[str]):
    root = ElementTree.fromstring(archive.read(path))
    for row in root.iter(_tag("row")):
        cells = {}
        for cell in row.findall(_tag("c")):
            col = _column_number(cell.attrib.get("r", ""))
            if col >= 0:
                cells[col] = _cell_value(cell, shared)
        if cells:
            yield cells


def _normalized_header(value: str) -> str:
    return re.sub(r"[^a-z]+", "", value.casefold())


def _media_from_value(value: str) -> str | None:
    normalized = re.sub(r"[^a-z]", "", value.casefold())
    if normalized in {"tv", "show", "shows", "series", "television", "tvshow"}:
        return "tv"
    if normalized in {"movie", "movies", "film", "films", "featurefilm"}:
        return "movie"
    return None


def _clean_title(value: str) -> str:
    return " ".join(value.strip().split())


def _strip_english_season(title: str) -> tuple[str, bool]:
    stripped = TERMINAL_SEASON.sub("", title).strip()
    return stripped, stripped != title


def _strip_equivalent_localized_season(alias: str) -> str:
    # The English first half has already proven this is a season label. For the
    # paired localized alias, remove only its final colon segment when it contains
    # a numeral, allowing localized words such as "시즌 3" or "第3季".
    head, colon, suffix = alias.rpartition(":")
    if colon and any(char.isnumeric() for char in suffix):
        return head.rstrip()
    return alias


def _release_year(value: str) -> int | None:
    """Year of a report's Release Date cell: an ISO date or, in older workbooks, an Excel serial."""
    value = value.strip()
    match = re.match(r"^(\d{4})-\d\d-\d\d", value)
    if match:
        return int(match.group(1))
    if re.fullmatch(r"\d{5}(?:\.\d+)?", value):
        return (datetime(1899, 12, 30) + timedelta(days=float(value))).year
    return None


def _titles_and_report_title(raw_title: str, media_type: str) -> tuple[list[str], str] | None:
    report_title = raw_title.strip()
    if not report_title:
        return None
    if report_title.casefold() in AGGREGATE_TITLES:
        return None
    if report_title.casefold() in HEADER_MARKERS:
        return None
    if report_title.casefold().startswith(FOOTNOTE_PREFIXES):
        return None
    parts = [_clean_title(part) for part in report_title.split(" // ")]
    parts = [part for part in parts if part]
    if not parts:
        return None
    # A title cell containing prose is a footnote, not catalogue content.
    if len(parts) == 1 and re.match(r"^(?:note|notes|source|disclaimer|as of)\b", parts[0], re.I):
        return None
    english, stripped_season = _strip_english_season(parts[0])
    if media_type == "tv" and stripped_season and english:
        parts[0] = english
        if len(parts) > 1:
            parts[1] = _strip_equivalent_localized_season(parts[1])
    unique_titles = sorted({part for part in parts if part})
    return (unique_titles, report_title) if unique_titles else None


def _classify_sheet(name: str) -> str | None:
    normalized = re.sub(r"[^a-z]", "", name.casefold())
    if normalized in {"shows", "tv", "tvshows", "televisionshows", "series"}:
        return "tv"
    if normalized in {"movies", "movie", "films", "film"}:
        return "movie"
    return None


def parse_workbook(path: Path, period: str) -> tuple[list[dict], bool]:
    """Return rows and whether at least one sheet had authoritative type data."""
    entries: list[dict] = []
    classified = False
    with zipfile.ZipFile(path) as archive:
        shared = _shared_strings(archive)
        for sheet_name, sheet_path in _workbook_sheets(archive):
            sheet_type = _classify_sheet(sheet_name)
            rows = list(_sheet_rows(archive, sheet_path, shared))
            if not rows:
                continue
            header = rows[0]
            title_col = next((col for col, value in header.items() if _normalized_header(value) == "title"), None)
            type_col = next((col for col, value in header.items() if _normalized_header(value) in {"type", "mediatype", "contenttype"}), None)
            release_col = next((col for col, value in header.items() if _normalized_header(value) == "releasedate"), None)
            # Some reports include a short heading before the header; find it in the first 10 rows.
            header_index = 0
            if title_col is None:
                for index, row in enumerate(rows[1:10], start=1):
                    candidate = next((col for col, value in row.items() if _normalized_header(value) == "title"), None)
                    if candidate is not None:
                        header, title_col, header_index = row, candidate, index
                        type_col = next((col for col, value in header.items() if _normalized_header(value) in {"type", "mediatype", "contenttype"}), None)
                        release_col = next((col for col, value in header.items() if _normalized_header(value) == "releasedate"), None)
                        break
            if title_col is None:
                continue
            current_sheet_type = sheet_type
            if type_col is not None:
                classified = True
            elif sheet_type:
                classified = True
            for row in rows[header_index + 1:]:
                raw_title = row.get(title_col, "")
                if not raw_title.strip():
                    continue
                media_type = current_sheet_type
                if type_col is not None:
                    media_type = _media_from_value(row.get(type_col, ""))
                if media_type is None:
                    continue
                parsed = _titles_and_report_title(raw_title, media_type)
                if parsed is None:
                    continue
                titles, report_title = parsed
                release_year = _release_year(row.get(release_col, "")) if release_col is not None else None
                entries.append({
                    "mediaType": media_type,
                    "titles": titles,
                    "reportTitles": [report_title],
                    "sourcePeriods": [period],
                    "releaseYears": [release_year] if release_year else [],
                })
    return entries, classified


def _download(source: dict, cache_dir: Path, timeout: float) -> Path:
    filename = source["downloadUrl"].rsplit("/", 1)[-1]
    destination = cache_dir / filename
    if destination.is_file() and zipfile.is_zipfile(destination):
        return destination
    request = urllib.request.Request(source["downloadUrl"], headers={"User-Agent": "Plekt Netflix catalogue updater/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response, destination.open("wb") as output:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
    if not zipfile.is_zipfile(destination):
        destination.unlink(missing_ok=True)
        raise ValueError("download did not contain a valid XLSX archive")
    return destination


def build_catalogue(source_rows: list[tuple[dict, Path]], generated_at: str | None = None) -> dict:
    merged: dict[tuple[str, tuple[str, ...]], dict] = {}
    source_manifest = []
    for source, workbook in source_rows:
        digest = hashlib.sha256(workbook.read_bytes()).hexdigest()
        parsed, classified = parse_workbook(workbook, source["period"])
        if not classified:
            print(f"SKIPPED {source['period']}: workbook has no authoritative TV/movie classification", file=sys.stderr)
            continue
        source_manifest.append({
            "period": source["period"], "url": source["url"],
            "downloadUrl": source["downloadUrl"], "sha256": digest,
        })
        for item in parsed:
            key = (item["mediaType"], tuple(item["titles"]))
            current = merged.setdefault(key, {
                "mediaType": item["mediaType"], "titles": item["titles"],
                "reportTitles": [], "sourcePeriods": [],
            })
            for report_title in item["reportTitles"]:
                if report_title not in current["reportTitles"]:
                    current["reportTitles"].append(report_title)
            if source["period"] not in current["sourcePeriods"]:
                current["sourcePeriods"].append(source["period"])
            # Netflix's premiere date: originals carry one, licensed titles usually do not.
            for year in item.get("releaseYears", []):
                current.setdefault("releaseYears", [])
                if year not in current["releaseYears"]:
                    current["releaseYears"].append(year)
    entries = sorted(merged.values(), key=lambda row: (row["mediaType"], tuple(row["titles"])))
    for entry in entries:
        entry["reportTitles"].sort(key=str.casefold)
        entry["sourcePeriods"].sort(reverse=True)
        if "releaseYears" in entry:
            entry["releaseYears"].sort()
    return {
        "schemaVersion": 1,
        "generatedAt": generated_at or datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "sources": source_manifest,
        "entries": entries,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache-dir", type=Path, default=Path(tempfile.gettempdir()) / "plekt-netflix-catalogue")
    parser.add_argument("--output", type=Path, default=OUTPUT)
    parser.add_argument("--timeout", type=float, default=90)
    parser.add_argument("--generated-at", help="Override generatedAt for reproducible snapshots, e.g. 2026-10-23T00:00:00Z")
    parser.add_argument("--period", action="append", dest="periods", help="Limit processing to a source period; may be repeated")
    args = parser.parse_args()

    sources = [source for source in SOURCES if not args.periods or source["period"] in args.periods]
    if args.periods:
        unknown = sorted(set(args.periods) - {source["period"] for source in SOURCES})
        if unknown:
            parser.error(f"unknown period(s): {', '.join(unknown)}")
    args.cache_dir.mkdir(parents=True, exist_ok=True)
    downloaded: list[tuple[dict, Path]] = []
    failures = []
    for source in sources:
        try:
            workbook = _download(source, args.cache_dir, args.timeout)
            downloaded.append((source, workbook))
            print(f"DOWNLOADED {source['period']}: {workbook}")
        except (OSError, urllib.error.URLError, zipfile.BadZipFile, ValueError) as error:
            failures.append((source["period"], error))
            print(f"FAILED {source['period']}: {error}", file=sys.stderr)

    catalogue = build_catalogue(downloaded, args.generated_at)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(catalogue, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    counts = {media_type: sum(row["mediaType"] == media_type for row in catalogue["entries"]) for media_type in ("tv", "movie")}
    print(f"WROTE {args.output}: {len(catalogue['entries'])} entries (tv={counts['tv']}, movie={counts['movie']}); {len(catalogue['sources'])} sources")
    if failures:
        print(f"SOURCE FAILURES: {len(failures)}", file=sys.stderr)
    if not catalogue["sources"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
