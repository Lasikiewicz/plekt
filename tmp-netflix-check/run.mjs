import fs from "node:fs";
const { prepareNetflixImport } = await import("../server/src/utils/netflixImport.js");
const csv = fs.readFileSync(process.argv[2], "utf8");
const p = await prepareNetflixImport(csv, {});
const reasons = {};
let rows = 0;
for (const g of p.reviews) {
  const items = g.type === "show" ? g.episodes : g.type === "year_matched" ? [] : [g];
  for (const i of items) { rows++; const k = `${g.type}|${i.reason}`; reasons[k] = (reasons[k] || 0) + 1; }
}
console.log(JSON.stringify({ total: p.total, records: p.matched, matchedByYear: p.matchedByYear, needsReview: p.needsReview, skipped: p.skipped, reviewRows: rows, reasons }, null, 1));
fs.writeFileSync(process.argv[3], JSON.stringify(p.reviews)); fs.writeFileSync(process.argv[3] + ".records.json", JSON.stringify(p.records));
process.exit(0);
