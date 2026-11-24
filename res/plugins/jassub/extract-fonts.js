#!/usr/bin/env node
'use strict';

// Extracts font attachments from MKV files into user/res/fonts/
// and rebuilds user/res/fonts/fonts.json index for jassub plugin.
// Usage: node res/plugins/jassub/extract-fonts.js [file.mkv | folder]...
// Without arguments only rebuilds the index (after manual font copying).
// Requires ffmpeg and ffprobe in PATH for extraction.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync, spawnSync } = require('child_process');

const fontsDir = path.resolve(__dirname, '../../../user/res/fonts');
const fontExts = ['ttf', 'otf', 'ttc', 'otc'];

function main() {
  fs.mkdirSync(fontsDir, { recursive: true });
  const files = process.argv.slice(2).flatMap(collectMkvs);
  let added = 0;
  for (const file of files) added += extractFonts(file);
  if (files.length) console.log(`Added ${added} new font(s) from ${files.length} file(s)`);
  writeIndex();
}

function collectMkvs(arg) {
  if (!fs.existsSync(arg)) {
    console.warn(`Not found: ${arg}`);
    return [];
  }
  if (!fs.statSync(arg).isDirectory()) return [arg];
  return fs.readdirSync(arg)
    .filter(name => /\.mk[av]$/i.test(name))
    .sort()
    .map(name => path.join(arg, name));
}

function getAttachments(file) {
  const out = execFileSync('ffprobe', [
    '-v', 'error', '-show_entries', 'stream=index,codec_type:stream_tags=filename',
    '-of', 'json', file
  ], { encoding: 'utf8' });
  return JSON.parse(out).streams
    .filter(s => s.codec_type == 'attachment' && s.tags?.filename)
    .map(s => ({ index: s.index, name: path.basename(s.tags.filename) }))
    .filter(a => fontExts.includes(getExt(a.name)));
}

function extractFonts(file) {
  let attachments;
  try {
    attachments = getAttachments(file);
  } catch (e) {
    console.warn(`Cannot read ${file}: ${e.message}`);
    return 0;
  }
  if (!attachments.length) return 0;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'synctube-fonts-'));
  try {
    const args = ['-v', 'error', '-y'];
    attachments.forEach((a, i) => args.push(`-dump_attachment:${a.index}`, path.join(tmp, `${i}`)));
    args.push('-i', file);
    // ffmpeg exits with "output file must be specified" error after dumping, ignore it
    spawnSync('ffmpeg', args, { stdio: 'ignore' });

    const known = new Map(listFonts().map(name => [hashFile(path.join(fontsDir, name)), name]));
    let added = 0;
    attachments.forEach((a, i) => {
      const tmpPath = path.join(tmp, `${i}`);
      if (!fs.existsSync(tmpPath)) {
        console.warn(`Failed to extract ${a.name} from ${file}`);
        return;
      }
      const hash = hashFile(tmpPath);
      if (known.has(hash)) return;
      const name = freeName(safeName(a.name));
      fs.copyFileSync(tmpPath, path.join(fontsDir, name));
      known.set(hash, name);
      added++;
    });
    return added;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function writeIndex() {
  const fonts = [];
  for (const file of listFonts()) {
    try {
      const faces = readFaces(fs.readFileSync(path.join(fontsDir, file)));
      const families = new Set();
      const names = new Set();
      for (const face of faces) {
        face.families.forEach(n => families.add(n));
        face.names.forEach(n => names.add(n));
      }
      if (!names.size) throw new Error('no names found');
      fonts.push({ file, families: [...families], names: [...names] });
    } catch (e) {
      console.warn(`Skipping ${file}: ${e.message}`);
    }
  }
  const indexPath = path.join(fontsDir, 'fonts.json');
  fs.writeFileSync(indexPath, JSON.stringify({ fonts }, null, '\t') + '\n');
  console.log(`Indexed ${fonts.length} font file(s) in ${indexPath}`);
}

// returns family and all other names of each face in ttf/otf/ttc file
function readFaces(buf) {
  const tag = buf.toString('latin1', 0, 4);
  const offsets = tag == 'ttcf'
    ? Array.from({ length: buf.readUInt32BE(8) }, (_, i) => buf.readUInt32BE(12 + i * 4))
    : [0];
  return offsets.map(offset => readNames(buf, offset));
}

function readNames(buf, offset) {
  const numTables = buf.readUInt16BE(offset + 4);
  let table = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = offset + 12 + i * 16;
    if (buf.toString('latin1', rec, rec + 4) == 'name') table = buf.readUInt32BE(rec + 8);
  }
  if (table == -1) throw new Error('no name table');
  const count = buf.readUInt16BE(table + 2);
  const strings = table + buf.readUInt16BE(table + 4);
  const families = new Set();
  const names = new Set();
  for (let i = 0; i < count; i++) {
    const rec = table + 6 + i * 12;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const nameId = buf.readUInt16BE(rec + 6);
    // family, full name, postscript name, typographic family
    if (![1, 4, 6, 16].includes(nameId)) continue;
    const start = strings + buf.readUInt16BE(rec + 10);
    const data = buf.subarray(start, start + buf.readUInt16BE(rec + 8));
    let value;
    if (platform == 0 || platform == 3) value = decodeUtf16be(data);
    else if (platform == 1 && encoding == 0) value = data.toString('latin1');
    else continue;
    value = value.replace(/\0/g, '').trim().toLowerCase();
    if (!value) continue;
    names.add(value);
    if (nameId == 1 || nameId == 16) families.add(value);
  }
  return { families: [...families], names: [...names] };
}

function decodeUtf16be(data) {
  const swapped = Buffer.from(data.subarray(0, data.length & ~1));
  swapped.swap16();
  return swapped.toString('utf16le');
}

function listFonts() {
  return fs.readdirSync(fontsDir).filter(name => fontExts.includes(getExt(name))).sort();
}

function getExt(name) {
  return path.extname(name).slice(1).toLowerCase();
}

function safeName(name) {
  return name.replace(/[\x00-\x1f/\\:*?"<>|]/g, '_');
}

function freeName(name) {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let result = name;
  for (let i = 2; fs.existsSync(path.join(fontsDir, result)); i++) result = `${base} (${i})${ext}`;
  return result;
}

function hashFile(file) {
  return crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');
}

main();
