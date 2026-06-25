const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

let cachedUsernames = null;

const EXPORT_FILE_NAME = "users_export_2026-06-25.xlsx";

function getDefaultExportPath() {
  return path.resolve(__dirname, "..", "..", "..", "..", "frontend", "karta", "public", EXPORT_FILE_NAME);
}

function decodeXml(value = "") {
  return String(value)
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function findEndOfCentralDirectory(buffer) {
  for (let offset = buffer.length - 22; offset >= 0; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  return -1;
}

function readZipEntries(buffer) {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  if (eocdOffset < 0) throw new Error("Invalid XLSX zip: EOCD not found");

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;

    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLength);

    entries.set(name, {
      method,
      compressedSize,
      localHeaderOffset,
    });

    offset += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function readZipFile(buffer, entries, filename) {
  const entry = entries.get(filename);
  if (!entry) return "";

  const localOffset = entry.localHeaderOffset;
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) return "";

  const nameLength = buffer.readUInt16LE(localOffset + 26);
  const extraLength = buffer.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLength + extraLength;
  const compressedData = buffer.subarray(dataStart, dataStart + entry.compressedSize);

  if (entry.method === 0) return compressedData.toString("utf8");
  if (entry.method === 8) return zlib.inflateRawSync(compressedData).toString("utf8");
  return "";
}

function parseSharedStrings(xml = "") {
  const shared = [];
  const siMatches = xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g);
  for (const match of siMatches) {
    const text = [...match[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((textMatch) => decodeXml(textMatch[1]))
      .join("");
    shared.push(text);
  }
  return shared;
}

function columnName(cellRef = "") {
  return String(cellRef).replace(/[0-9]/g, "");
}

function readCellValue(cellXml, sharedStrings) {
  const typeMatch = cellXml.match(/\bt="([^"]+)"/);
  const type = typeMatch?.[1] || "";

  if (type === "inlineStr") {
    const inlineText = [...cellXml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
      .map((match) => decodeXml(match[1]))
      .join("");
    return inlineText.trim();
  }

  const valueMatch = cellXml.match(/<v>([\s\S]*?)<\/v>/);
  const rawValue = valueMatch ? decodeXml(valueMatch[1]).trim() : "";
  if (type === "s" && rawValue !== "") {
    return String(sharedStrings[Number(rawValue)] || "").trim();
  }
  return rawValue;
}

function parseRows(sheetXml = "", sharedStrings = []) {
  const rows = [];
  const rowMatches = sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g);
  for (const rowMatch of rowMatches) {
    const row = {};
    const cellMatches = rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g);
    for (const cellMatch of cellMatches) {
      const attrs = cellMatch[1] || "";
      const ref = attrs.match(/\br="([^"]+)"/)?.[1] || "";
      if (!ref) continue;
      row[columnName(ref)] = readCellValue(`<c ${attrs}>${cellMatch[2]}</c>`, sharedStrings);
    }
    rows.push(row);
  }
  return rows;
}

function normalizeUsername(value) {
  const username = String(value || "").replace(/^@/, "").trim();
  if (!username || /^unknown$/i.test(username)) return "";
  return /^[A-Za-z0-9_]{5,32}$/.test(username) ? username : "";
}

function loadExportUsernames() {
  if (cachedUsernames) return cachedUsernames;

  const exportPath = process.env.BOT_USERNAME_EXPORT_PATH || getDefaultExportPath();
  try {
    const buffer = fs.readFileSync(exportPath);
    const entries = readZipEntries(buffer);
    const sharedStrings = parseSharedStrings(readZipFile(buffer, entries, "xl/sharedStrings.xml"));
    const sheetXml = readZipFile(buffer, entries, "xl/worksheets/sheet1.xml");
    const rows = parseRows(sheetXml, sharedStrings);
    const headers = rows[0] || {};
    const usernameColumn = Object.entries(headers)
      .find(([, header]) => String(header).trim().toLowerCase() === "username")?.[0];

    if (!usernameColumn) {
      cachedUsernames = [];
      return cachedUsernames;
    }

    cachedUsernames = [...new Set(rows.slice(1)
      .map((row) => normalizeUsername(row[usernameColumn]))
      .filter(Boolean))];
    return cachedUsernames;
  } catch (error) {
    console.warn(`Could not load bot usernames from ${exportPath}:`, error.message);
    cachedUsernames = [];
    return cachedUsernames;
  }
}

function getRandomExportUsername() {
  const usernames = loadExportUsernames();
  if (!usernames.length) return "";
  return usernames[Math.floor(Math.random() * usernames.length)];
}

module.exports = {
  getRandomExportUsername,
  loadExportUsernames,
};
