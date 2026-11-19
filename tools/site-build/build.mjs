#!/usr/bin/env node
/* Build the published copy of tcatlas.org.

   The repo is the source: commented, readable JS and CSS, served as-is by
   `python3 -m http.server` for local work. Visitors get this build instead
   (.github/workflows/deploy-site.yml runs it on every push to main):

     - first-party .js and .css  → comments and whitespace stripped, with a
       source map next to each file so browser dev tools still show the
       source. Names are NOT shortened: pages call each other's globals and
       inline onclick="" handlers call them by name.
     - everything else the site serves (HTML, JSON, images, vendored
       libraries) → copied byte for byte.
     - backend and tooling files (Python, shell, Dockerfiles, plans, tests)
       → left out. They were never part of the site; see NOT_SITE below.

   Same file names, same ?v= cache tokens, so no page changes with it. A
   file the minifier can't read is published as committed, with a warning,
   rather than blocking the deploy.

     node tools/site-build/build.mjs [--out _site]

   Only tracked files are published (git ls-files), so a local build never
   ships scratch files. */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* Not part of the site. KEEP IN STEP with `paths-ignore` in
   .github/workflows/deploy-site.yml: a push that only touches these does
   not need a deploy. A new kind of file is published unless it is listed
   here, so forgetting to list one costs bytes, never a broken page. */
const NOT_SITE_DIRS = ['.github/', 'tools/', 'tests/', 'bin/', 'pipeline/', 'scripts/',
                       'cloudflare/', 'r2/', 'monitoring/', 'docs/', 'og_assets/'];
const NOT_SITE_EXT = new Set(['.py', '.sh', '.md', '.plist', '.docx', '.npz']);
const NOT_SITE_FILES = new Set(['requirements.txt', 'deploy.env.example', 'ir_cache_lifecycle.json']);
export function isSite(file) {
    const base = path.basename(file);
    if (file.split('/').some((part) => part.startsWith('.'))) return false;   // dotfiles: Pages never served them
    if (NOT_SITE_DIRS.some((d) => file.startsWith(d))) return false;
    if (NOT_SITE_EXT.has(path.extname(file))) return false;
    if (NOT_SITE_FILES.has(file)) return false;
    if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) return false;
    return true;
}

/* Third-party code ships already minified (and with its own licence
   header): copy it. vendor/gc-atlas is first-party source, so it is
   minified like the rest. */
export function isMinifiable(file) {
    const ext = path.extname(file);
    if (ext !== '.js' && ext !== '.css') return false;
    if (file.startsWith('assets/vendor/')) return false;
    if (/\.min\.(js|css)$/.test(file)) return false;
    return true;
}

/* Comments and whitespace only. esbuild can also rewrite syntax (merge
   adjacent CSS rules, turn `a != null ? a : b` into `a ?? b`), which
   measured under 1% smaller after gzip and is not worth output that has to
   be trusted rather than checked: with it off, every stylesheet parses to
   the same rules as its source and no script gains syntax its source did
   not use. */
async function minify(file, src) {
    const isCss = file.endsWith('.css');
    const result = await esbuild.transform(src, {
        loader: isCss ? 'css' : 'js',
        minifyWhitespace: true,
        minifySyntax: false,
        minifyIdentifiers: false,
        charset: 'utf8',
        sourcemap: 'external',
        // Dev tools list the readable source as source/<file>, apart from the
        // minified file of the same name that the page actually runs.
        sourcefile: 'source/' + path.basename(file),
        logLevel: 'silent',
    });
    const mapName = path.basename(file) + '.map';
    const trailer = isCss ? `\n/*# sourceMappingURL=${mapName} */\n` : `\n//# sourceMappingURL=${mapName}\n`;
    return { code: result.code.trimEnd() + trailer, map: result.map, warnings: result.warnings };
}

const gz = (buf) => zlib.gzipSync(buf, { level: 6 }).length;
const kb = (n) => n >= 10 << 20 ? (n / 1048576).toFixed(0) + ' MB' : (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';

async function main() {
    const outArg = process.argv.indexOf('--out');
    const OUT = path.resolve(ROOT, outArg > -1 ? process.argv[outArg + 1] : '_site');
    if (OUT === ROOT || ROOT.startsWith(OUT + path.sep)) throw new Error('--out must not be the repo root');

    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 << 20 })
        .toString().split('\0').filter(Boolean);
    const outRel = path.relative(ROOT, OUT).split(path.sep).join('/') + '/';
    const site = tracked.filter((f) => isSite(f) && !f.startsWith(outRel));
    if (!site.includes('index.html')) throw new Error('index.html is not among the tracked files: wrong directory?');

    fs.rmSync(OUT, { recursive: true, force: true });
    const rows = [];        // [file, rawBefore, rawAfter, gzBefore, gzAfter]
    const warnings = [];
    let copiedBytes = 0;

    await Promise.all(site.map(async (file) => {
        const from = path.join(ROOT, file);
        const to = path.join(OUT, file);
        fs.mkdirSync(path.dirname(to), { recursive: true });
        if (!isMinifiable(file)) {
            fs.copyFileSync(from, to);
            copiedBytes += fs.statSync(from).size;
            return;
        }
        const srcBuf = fs.readFileSync(from);
        try {
            const out = await minify(file, srcBuf.toString('utf8'));
            const outBuf = Buffer.from(out.code, 'utf8');
            // A "minified" file that came out no smaller is not worth a second copy of the truth.
            if (outBuf.length >= srcBuf.length) { fs.copyFileSync(from, to); copiedBytes += srcBuf.length; return; }
            fs.writeFileSync(to, outBuf);
            fs.writeFileSync(to + '.map', out.map);
            rows.push([file, srcBuf.length, outBuf.length, gz(srcBuf), gz(outBuf)]);
            for (const w of out.warnings) warnings.push(`${file}:${w.location ? w.location.line : '?'} ${w.text}`);
        } catch (e) {
            fs.copyFileSync(from, to);
            copiedBytes += srcBuf.length;
            const first = (e.errors && e.errors[0]) || {};
            const where = first.location ? `:${first.location.line}` : '';
            warnings.push(`${file}${where} not minified, published as committed: ${first.text || e.message}`);
            console.log(`::warning file=${file}::not minified, published as committed: ${first.text || e.message}`);
        }
    }));
    if (!rows.length) throw new Error('nothing was minified: the build is not doing its job');

    rows.sort((a, b) => (b[3] - b[4]) - (a[3] - a[4]));
    const sum = (i) => rows.reduce((t, r) => t + r[i], 0);
    const commit = process.env.GITHUB_SHA
        || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT }).toString().trim();
    const info = {
        commit,
        built_at: new Date().toISOString(),
        files_published: site.length,
        files_minified: rows.length,
        minified_bytes: { before: sum(1), after: sum(2) },
        minified_gzip_bytes: { before: sum(3), after: sum(4) },
    };
    // Which build is live: https://tcatlas.org/build-info.json
    fs.writeFileSync(path.join(OUT, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');

    const pct = (a, b) => (100 * (1 - b / a)).toFixed(0) + '%';
    const lines = [
        `### Site build ${commit.slice(0, 7)}`,
        '',
        `${site.length} files published (${tracked.length - site.length} backend/tooling files left out); ` +
        `${rows.length} scripts and stylesheets minified, ${kb(copiedBytes)} copied as committed.`,
        '',
        `Minified files, as visitors download them (gzip): **${kb(sum(3))} → ${kb(sum(4))}** (${pct(sum(3), sum(4))} smaller).`,
        '',
        '| File | Source | Minified | gzip before | gzip after |',
        '|---|---:|---:|---:|---:|',
        ...rows.slice(0, 12).map((r) => `| ${r[0]} | ${kb(r[1])} | ${kb(r[2])} | ${kb(r[3])} | ${kb(r[4])} |`),
        rows.length > 12 ? `| …and ${rows.length - 12} more | | | | |` : '',
        '',
        ...(warnings.length ? ['**Warnings**', '', ...warnings.map((w) => `- ${w}`), ''] : []),
    ].filter((l) => l !== null);
    const report = lines.join('\n');
    console.log(report);
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, report + '\n');
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main().catch((e) => { console.error(e.stack || String(e)); process.exit(1); });
}
