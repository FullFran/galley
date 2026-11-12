#!/usr/bin/env node
// Builds web/public/tex/: the in-browser TeX engine assets.
//
//   node scripts/build-tex.mjs [--dry-run]
//
// 1. Downloads the pinned upstream busytex release assets listed in tex/assets.json into a cache
//    directory (default web/.tex-cache, override with GALLEY_TEX_CACHE) and verifies their SHA-256.
//    A mismatch is fatal.
// 2. Merges the upstream Emscripten file_packager data packages (LZ4 chunked), selects the files
//    named in tex/manifest.txt, adds the vendored files from tex/extra/, regenerates the kpathsea
//    ls-R databases and writes ONE data package (galley-tex.js + galley-tex.data) in the same
//    format, reusing the upstream loader as the template so the vendored pipeline loads it unchanged.
// 3. Copies the engine (busytex.js, busytex.wasm, texmf.cnf), the vendored pipeline/worker and
//    LICENSES.md next to it.
//
// Plain Node ESM, no dependencies. The output is deterministic, so running it twice is a no-op in
// content (the second run only reuses the cache). --dry-run stops after the selection summary.

/* global process, Buffer */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const TEX = join(WEB, 'tex');
const OUT = join(WEB, 'public', 'tex');
const CACHE = process.env.GALLEY_TEX_CACHE ? resolve(process.env.GALLEY_TEX_CACHE) : join(WEB, '.tex-cache');
const DRY = process.argv.includes('--dry-run');

const PACKAGE_NAME = 'galley-tex';
const TEXMF = '/texlive/texmf-dist'; // every selected texmf file lives under this single tree
const CHUNK = 2048; // Emscripten LZ4 chunk size used by the upstream loader and busytex.js
const PAD = CHUNK * 2; // room for the two decompressed-chunk caches that LZ4.loadPackage expects

const mb = (n) => (n / 1048576).toFixed(1) + ' MB';
const log = (...a) => console.log(...a);

// ---------------------------------------------------------------------------------------------
// Download and verify
// ---------------------------------------------------------------------------------------------

async function sha256File(path) {
  const h = createHash('sha256');
  await pipeline(createReadStream(path), h);
  return h.digest('hex');
}

async function ensureAsset(assets, name) {
  const expected = assets.files[name];
  const path = join(CACHE, name);
  if (existsSync(path) && (await sha256File(path)) === expected) return path;
  const url = `https://github.com/${assets.repo}/releases/download/${assets.tag}/${name}`;
  log(`download ${name}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${url}`);
  const tmp = path + '.part';
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  const actual = await sha256File(tmp);
  if (actual !== expected) {
    await rm(tmp, { force: true });
    throw new Error(`SHA-256 mismatch for ${name}: expected ${expected}, got ${actual}`);
  }
  await rename(tmp, path);
  return path;
}

// ---------------------------------------------------------------------------------------------
// LZ4 block codec (the subset of the format the Emscripten loader uses)
// ---------------------------------------------------------------------------------------------

function lz4Decompress(src, outLen) {
  const dst = Buffer.alloc(outLen);
  let sp = 0;
  let dp = 0;
  while (sp < src.length) {
    const token = src[sp++];
    let lit = token >> 4;
    if (lit === 15) {
      let b;
      do {
        b = src[sp++];
        lit += b;
      } while (b === 255);
    }
    src.copy(dst, dp, sp, sp + lit);
    sp += lit;
    dp += lit;
    if (sp >= src.length) break;
    const offset = src[sp] | (src[sp + 1] << 8);
    sp += 2;
    let mlen = token & 15;
    if (mlen === 15) {
      let b;
      do {
        b = src[sp++];
        mlen += b;
      } while (b === 255);
    }
    mlen += 4;
    for (let i = 0; i < mlen; i++, dp++) dst[dp] = dst[dp - offset];
  }
  // Only the last chunk of a package may be shorter than outLen.
  if (dp > outLen) throw new Error(`LZ4 chunk decoded to ${dp} bytes, expected at most ${outLen}`);
  return dst.subarray(0, dp);
}

/** Greedy LZ4 block compressor. Returns null when the chunk does not shrink. */
function lz4Compress(src) {
  const n = src.length;
  if (n < 16) return null;
  const out = Buffer.alloc(n + (n >> 8) + 16);
  const table = new Int32Array(1 << 12).fill(-1);
  const matchEnd = n - 5; // the last 5 bytes must be literals
  const lastStart = n - 12; // the last match must start at least 12 bytes before the end
  let op = 0;
  let anchor = 0;
  let ip = 0;
  const extLen = (len) => {
    while (len >= 255) {
      out[op++] = 255;
      len -= 255;
    }
    out[op++] = len;
  };
  while (ip <= lastStart) {
    const seq = src.readUInt32LE(ip);
    const h = Math.imul(seq, 2654435761) >>> 20;
    const ref = table[h];
    table[h] = ip;
    if (ref < 0 || ip - ref > 65535 || src.readUInt32LE(ref) !== seq) {
      ip++;
      continue;
    }
    let mlen = 4;
    while (ip + mlen < matchEnd && src[ref + mlen] === src[ip + mlen]) mlen++;
    const lit = ip - anchor;
    const m = mlen - 4;
    out[op++] = (Math.min(lit, 15) << 4) | Math.min(m, 15);
    if (lit >= 15) extLen(lit - 15);
    src.copy(out, op, anchor, ip);
    op += lit;
    out[op++] = (ip - ref) & 255;
    out[op++] = (ip - ref) >> 8;
    if (m >= 15) extLen(m - 15);
    ip += mlen;
    anchor = ip;
  }
  const lit = n - anchor;
  out[op++] = Math.min(lit, 15) << 4;
  if (lit >= 15) extLen(lit - 15);
  src.copy(out, op, anchor, n);
  op += lit;
  return op < n ? out.subarray(0, op) : null;
}

// ---------------------------------------------------------------------------------------------
// Reading the upstream packages
// ---------------------------------------------------------------------------------------------

/** Parses an Emscripten file_packager loader (.js) and returns its metadata and chunk table. */
function parseLoader(text) {
  const marker = text.lastIndexOf('loadPackage({');
  if (marker < 0) throw new Error('no loadPackage({...}) call found in the loader');
  const eol = text.indexOf('\n', marker);
  const meta = JSON.parse(text.slice(marker + 'loadPackage('.length, text.lastIndexOf(')', eol)));
  const cdStart = text.indexOf('var compressedData = ');
  if (cdStart < 0) throw new Error('loader is not an LZ4 package (no compressedData)');
  const cdEnd = text.indexOf('\n', cdStart);
  const table = JSON.parse(text.slice(cdStart + 'var compressedData = '.length, cdEnd).replace(/;\s*$/, ''));
  return { meta, table };
}

class UpstreamPackage {
  constructor(name, loaderText, data) {
    this.name = name;
    this.data = data;
    const { meta, table } = parseLoader(loaderText);
    this.files = meta.files;
    this.table = table;
    this.lastIndex = -1;
    this.lastChunk = null;
  }

  chunk(i) {
    if (i === this.lastIndex) return this.lastChunk;
    const { offsets, sizes, successes } = this.table;
    const raw = this.data.subarray(offsets[i], offsets[i] + sizes[i]);
    this.lastChunk = successes[i] ? lz4Decompress(raw, CHUNK) : raw;
    this.lastIndex = i;
    return this.lastChunk;
  }

  read(file) {
    const parts = [];
    for (let c = Math.floor(file.start / CHUNK); file.end > file.start && c <= Math.floor((file.end - 1) / CHUNK); c++) {
      const chunk = this.chunk(c);
      parts.push(chunk.subarray(Math.max(file.start - c * CHUNK, 0), Math.min(file.end - c * CHUNK, chunk.length)));
    }
    return Buffer.concat(parts);
  }
}

// ---------------------------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------------------------

function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$');
}

/**
 * One rule per line: `pattern` includes, `!pattern` excludes, `#` starts a comment. A pattern
 * without a leading slash is relative to /texlive/texmf-dist; a trailing slash means the whole
 * directory tree; `*` stays inside a path segment and `**` crosses segments. Excludes apply to the
 * includes above and below them. Every include rule must match at least one file.
 */
function parseManifest(text) {
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const exclude = line.startsWith('!');
    let pattern = exclude ? line.slice(1).trim() : line;
    if (!pattern.startsWith('/')) pattern = `${TEXMF}/${pattern}`;
    const tree = pattern.endsWith('/');
    const regexp = globToRegExp(tree ? pattern + '**' : pattern);
    rules.push({ line, exclude, regexp, hits: 0 });
  }
  return rules;
}

function selectFiles(paths, rules) {
  const picked = new Set();
  for (const p of paths) {
    let included = false;
    for (const r of rules) {
      if (r.regexp.test(p)) {
        r.hits++;
        if (!r.exclude) included = true;
      }
    }
    if (included && !rules.some((r) => r.exclude && r.regexp.test(p))) picked.add(p);
  }
  const dead = rules.filter((r) => !r.exclude && r.hits === 0).map((r) => r.line);
  if (dead.length) throw new Error(`manifest rules matching no file:\n  ${dead.join('\n  ')}`);
  return picked;
}

// ---------------------------------------------------------------------------------------------
// ls-R
// ---------------------------------------------------------------------------------------------

/** kpathsea filename database for the files below `root` (a directory of the virtual file system). */
function buildLsR(root, paths) {
  const dirs = new Map([['', new Set()]]);
  for (const p of paths) {
    if (!p.startsWith(root + '/')) continue;
    const parts = p.slice(root.length + 1).split('/');
    let dir = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const next = dir ? `${dir}/${parts[i]}` : parts[i];
      if (!dirs.has(next)) dirs.set(next, new Set());
      dirs.get(dir).add(parts[i]);
      dir = next;
    }
    dirs.get(dir).add(parts.at(-1));
  }
  dirs.get('').add('ls-R');
  let text = '% ls-R -- filename database for kpathsea; do not change this line.\n';
  for (const dir of [...dirs.keys()].sort()) {
    text += `\n./${dir}:\n${[...dirs.get(dir)].sort().join('\n')}\n`;
  }
  return Buffer.from(text);
}

// ---------------------------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------------------------

function pack(entries) {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : 1));
  const files = [];
  let offset = 0;
  for (const e of sorted) {
    files.push({ filename: e.path, start: offset, end: offset + e.data.length });
    offset += e.data.length;
  }
  const raw = Buffer.concat(sorted.map((e) => e.data));
  const chunks = [];
  const successes = [];
  for (let i = 0; i < raw.length; i += CHUNK) {
    const piece = raw.subarray(i, i + CHUNK);
    const packed = lz4Compress(piece);
    chunks.push(packed ?? piece);
    successes.push(packed ? 1 : 0);
  }
  const offsets = [];
  const sizes = [];
  let total = 0;
  for (const c of chunks) {
    offsets.push(total);
    sizes.push(c.length);
    total += c.length;
  }
  const data = Buffer.concat([...chunks, Buffer.alloc(PAD)]);
  return { files, rawSize: raw.length, data, table: { offsets, sizes, successes, cachedOffset: total } };
}

/** Rebuilds the upstream loader with the new package name, file list and chunk table. */
function buildLoader(template, { files, data, table }, uuid, provides) {
  let js = template.replace(/^\/\/.*\n/gm, '');
  const swap = (from, to, expected) => {
    const n = js.split(from).length - 1;
    if (n !== expected) throw new Error(`loader template: expected ${expected} occurrences of ${from}, found ${n}`);
    js = js.split(from).join(to);
  };
  swap('texlive-basic.data', `${PACKAGE_NAME}.data`, 4);
  if (js.includes('texlive-basic')) throw new Error('loader template: unexpected remaining package name');
  // Directory creation lines are redundant (LZ4.loadPackage creates the directories) but kept for parity.
  const dirs = new Set();
  for (const f of files) {
    const parts = f.filename.split('/').filter(Boolean);
    for (let i = 1; i < parts.length; i++) dirs.add('/' + parts.slice(0, i).join('/'));
  }
  const dirLines = [...dirs]
    .sort()
    .map((d) => `Module['FS_createPath'](${JSON.stringify(d.slice(0, d.lastIndexOf('/')) || '/')}, ${JSON.stringify(d.slice(d.lastIndexOf('/') + 1))}, true, true);`);
  const lines = js.split('\n');
  const isDir = (l) => l.startsWith("Module['FS_createPath'](");
  const first = lines.findIndex(isDir);
  if (first < 0) throw new Error('loader template: no FS_createPath block');
  js = [...lines.slice(0, first), ...dirLines, ...lines.slice(first).filter((l) => !isDir(l))].join('\n');
  const cdStart = js.indexOf('var compressedData = ');
  if (cdStart < 0) throw new Error('loader template: no compressedData');
  const cdEnd = js.indexOf('\n', cdStart);
  const cd = { data: null, cachedOffset: table.cachedOffset, cachedIndexes: [-1, -1], cachedChunks: [null, null], offsets: table.offsets, sizes: table.sizes, successes: table.successes };
  js = js.slice(0, cdStart) + 'var compressedData = ' + JSON.stringify(cd) + ';' + js.slice(cdEnd);
  const lp = js.lastIndexOf('loadPackage({');
  const lpEnd = js.indexOf('\n', lp);
  const meta = { files, remote_package_size: data.length, package_uuid: uuid };
  js = js.slice(0, lp) + 'loadPackage(' + JSON.stringify(meta) + ');' + js.slice(lpEnd);
  return provides + js;
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const assets = JSON.parse(await readFile(join(TEX, 'assets.json'), 'utf8'));
  await mkdir(CACHE, { recursive: true });
  const cached = {};
  for (const name of Object.keys(assets.files)) cached[name] = await ensureAsset(assets, name);

  // Merge the upstream packages into one logical tree. /texmf/texmf-dist (the Ubuntu packages) is
  // mapped onto /texlive/texmf-dist, and the first package that provides a path wins, which is the
  // same precedence kpathsea gives the two trees.
  const merged = new Map();
  for (const loader of assets.packages) {
    const pkg = new UpstreamPackage(loader, await readFile(cached[`${loader}.js`], 'utf8'), await readFile(cached[`${loader}.data`]));
    for (const f of pkg.files) {
      const path = f.filename.startsWith('/texmf/texmf-dist/') ? TEXMF + f.filename.slice('/texmf/texmf-dist'.length) : f.filename;
      if (!merged.has(path)) merged.set(path, { pkg, file: f });
    }
  }

  const rules = parseManifest(await readFile(join(TEX, 'manifest.txt'), 'utf8'));
  const picked = selectFiles(merged.keys(), rules);
  const entries = new Map();
  for (const p of picked) {
    const { pkg, file } = merged.get(p);
    entries.set(p, { path: p, data: pkg.read(file), pkg: pkg.name });
  }

  // Vendored files that no upstream package provides (elsarticle, LPPL).
  const extraDir = join(TEX, 'extra');
  for (const name of (await readdir(extraDir)).sort()) {
    const where = /\.(cls|sty)$/.test(name) ? 'tex/latex/elsarticle' : name.endsWith('.bst') ? 'bibtex/bst/elsarticle' : null;
    if (!where) continue;
    entries.set(`${TEXMF}/${where}/${name}`, { path: `${TEXMF}/${where}/${name}`, data: await readFile(join(extraDir, name)), pkg: 'extra' });
  }

  // kpathsea only looks in ls-R for the !! trees, so the databases must describe exactly this subset.
  const dbRoots = [TEXMF, `${TEXMF}/texmf-var`, `${TEXMF}/texmf-config`];
  const paths = [...entries.keys()];
  for (const root of dbRoots) {
    const present = paths.some((p) => p.startsWith(root + '/'));
    if (present || root === TEXMF) entries.set(`${root}/ls-R`, { path: `${root}/ls-R`, data: buildLsR(root, paths), pkg: 'generated' });
  }

  const byPkg = {};
  let rawTotal = 0;
  for (const e of entries.values()) {
    byPkg[e.pkg] = (byPkg[e.pkg] ?? 0) + e.data.length;
    rawTotal += e.data.length;
  }
  log(`selected ${entries.size} files, ${mb(rawTotal)} uncompressed`);
  log('  by source: ' + Object.entries(byPkg).map(([k, v]) => `${k} ${mb(v)}`).join(', '));
  const unused = assets.packages.filter((p) => !byPkg[p]);
  if (unused.length) log(`  note: no file is taken from ${unused.join(', ')}`);
  if (DRY) {
    const top = {};
    for (const e of entries.values()) {
      const k = e.path.split('/').slice(0, 5).join('/');
      top[k] = (top[k] ?? 0) + e.data.length;
    }
    for (const [k, v] of Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 25)) log(`  ${mb(v).padStart(8)}  ${k}`);
    return;
  }

  const packed = pack(entries.values());
  const uuid = 'sha256-' + createHash('sha256').update(packed.data).digest('hex');
  const stems = [...entries.keys()].filter((p) => p.endsWith('.sty')).map((p) => p.slice(p.lastIndexOf('/') + 1, -4));
  const provides = [...new Set(stems)].sort().map((s) => `// \\ProvidesPackage{${s}}\n`).join('');
  const template = await readFile(cached['texlive-basic.js'], 'utf8');
  const loader = buildLoader(template, packed, uuid, provides);

  await mkdir(OUT, { recursive: true });
  await writeFile(join(OUT, `${PACKAGE_NAME}.data`), packed.data);
  await writeFile(join(OUT, `${PACKAGE_NAME}.js`), loader);
  for (const name of ['busytex.js', 'busytex.wasm', 'texmf.cnf']) await copyFile(cached[name], join(OUT, name));
  for (const name of ['busytex_pipeline.js', 'busytex_worker.js']) await copyFile(join(TEX, 'vendor', name), join(OUT, name));
  await copyFile(join(TEX, 'LICENSES.md'), join(OUT, 'LICENSES.md'));

  log(`wrote ${OUT}`);
  for (const name of (await readdir(OUT)).sort()) {
    const size = (await stat(join(OUT, name))).size;
    if (size > 99 * 1048576) throw new Error(`${name} is ${mb(size)}, over the 100 MB GitHub Pages file limit`);
    log(`  ${mb(size).padStart(9)}  ${name}`);
  }
  log(`data package: ${mb(packed.rawSize)} uncompressed, ${mb(packed.data.length)} LZ4, ${mb(gzipSync(packed.data, { level: 9 }).length)} gzip`);
  log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
