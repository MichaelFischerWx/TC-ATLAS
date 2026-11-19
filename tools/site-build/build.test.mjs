/* node --test tools/site-build/
   What the build publishes, and that the workflow's `paths-ignore` agrees
   with it. If the two drift, either a push that changes the site does not
   deploy (bad) or a backend-only push spends a deploy (wasteful). */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isSite, isMinifiable } from './build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, maxBuffer: 64 << 20 })
    .toString().split('\0').filter(Boolean);

// GitHub's path filters: `**` crosses directories, `*` does not.
function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*' && glob[i + 1] === '*') {
            if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
        } else if (c === '*') re += '[^/]*';
        else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
    }
    return new RegExp('^' + re + '$');
}
const workflow = fs.readFileSync(path.join(ROOT, '.github/workflows/deploy-site.yml'), 'utf8');
const block = workflow.slice(workflow.indexOf('paths-ignore:'), workflow.indexOf('workflow_dispatch:'));
const ignores = [...block.matchAll(/^\s+- '([^']+)'\s*$/gm)].map((m) => globToRegExp(m[1]));
const ignored = (file) => ignores.some((re) => re.test(file));

test('the pages and what they load are published', () => {
    for (const f of ['index.html', 'realtime_ir.html', 'realtime_ir.js', 'tc_radar_styles.css', 'theme.js',
                     'ibtracs_storms.json', 'ibtracs_tracks_p0.json', 'data/indices_monthly_era5.json',
                     'assets/vendor/maplibre5/maplibre-gl.js', 'vendor/gc-atlas/globe.js', 'robots.txt',
                     'sitemap.xml', 'manifest.json', 'CNAME', '404.html', 'tc-atlas-favicon-32.png']) {
        assert.ok(tracked.includes(f), `${f} is tracked`);
        assert.ok(isSite(f), `${f} should be published`);
    }
});

test('backend and tooling files are not published', () => {
    for (const f of ['ir_monitor_api.py', 'deploy.sh', 'Dockerfile', 'Dockerfile.mw', 'DEPLOY_NOTES.md',
                     'requirements.txt', 'pipeline/pack_tracks.py', 'tests/test_pack_tracks.py',
                     'tools/site-build/build.mjs', '.github/workflows/deploy-site.yml', '.gitignore',
                     'climatology_hybrid.npz', 'og_assets/DMSans-var.ttf']) {
        assert.ok(!isSite(f), `${f} should not be published`);
    }
});

test('vendored libraries are copied, first-party code is minified', () => {
    assert.ok(!isMinifiable('assets/vendor/maplibre5/maplibre-gl.js'));
    assert.ok(!isMinifiable('assets/vendor/leaflet/leaflet.css'));
    assert.ok(!isMinifiable('index.html'));
    assert.ok(isMinifiable('realtime_ir.js'));
    assert.ok(isMinifiable('tc_radar_styles.css'));
    assert.ok(isMinifiable('vendor/gc-atlas/globe.js'));
});

test('paths-ignore never skips a deploy for a published file', () => {
    assert.ok(ignores.length > 10, 'paths-ignore list was read from the workflow');
    const skipped = tracked.filter((f) => isSite(f) && ignored(f));
    assert.deepEqual(skipped, []);
});

test('paths-ignore covers every unpublished file except the build itself', () => {
    const buildItself = (f) => f.startsWith('.github/') || f.startsWith('tools/');
    const wasteful = tracked.filter((f) => !isSite(f) && !buildItself(f) && !ignored(f));
    assert.deepEqual(wasteful, []);
    assert.ok(!ignored('tools/site-build/build.mjs') && !ignored('.github/workflows/deploy-site.yml'),
        'a change to the build must redeploy');
});
