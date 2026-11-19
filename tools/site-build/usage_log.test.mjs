/* node --test tools/site-build/   (no network: fixed run history in, summary out) */
import test from 'node:test';
import assert from 'node:assert/strict';
import { billedMinutes, summarize, render } from './usage_log.mjs';

const run = (id, started, seconds, extra = {}) => ({
    id, head_sha: 'abcdef1234567', display_title: `Commit ${id}`, status: 'completed', conclusion: 'success',
    run_started_at: started, created_at: started,
    updated_at: new Date(Date.parse(started) + seconds * 1000).toISOString(), ...extra,
});

test('a job is rounded up to a whole minute, never zero', () => {
    assert.equal(billedMinutes(0), 1);
    assert.equal(billedMinutes(35), 1);
    assert.equal(billedMinutes(60), 1);
    assert.equal(billedMinutes(61), 2);
    assert.equal(billedMinutes(605), 11);
});

test('month to date: only this month, newest first, running run timed to now', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    const s = summarize([
        run(1, '2026-10-31T23:50:00Z', 40),                       // last month: not counted
        run(2, '2026-11-02T10:00:00Z', 38),
        run(3, '2026-11-10T09:00:00Z', 95, { conclusion: 'failure' }),
        run(4, '2026-11-15T11:59:20Z', 0, { status: 'in_progress', conclusion: null, updated_at: '2026-11-15T11:59:21Z' }),
    ], { now, isPrivate: true, currentRunId: 4 });
    assert.equal(s.deploys, 3);
    assert.deepEqual(s.rows.map((r) => r.id), [4, 3, 2]);
    assert.deepEqual(s.rows.map((r) => r.minutes), [1, 2, 1]);
    assert.equal(s.rows[0].seconds, 40);                           // 11:59:20 → now
    assert.equal(s.rows[0].result, 'this run');
    assert.equal(s.rows[1].result, 'failure');                     // failed runs still cost minutes
    assert.equal(s.minutes, 4);
    assert.equal(s.projected, 8);                                  // 4 minutes in 15 of 30 days
    assert.equal(s.share, 4 / 2000);
});

test('a public repo reports no share of an allowance', () => {
    const now = new Date('2026-11-15T12:00:00Z');
    const s = summarize([run(2, '2026-11-02T10:00:00Z', 38)], { now, isPrivate: false });
    assert.equal(s.share, 0);
    const text = render(s);
    assert.match(text, /public: standard runners are free and uncapped/);
    assert.match(text, /1 deploy this month, 1 Actions minute\b/);
    assert.match(text, /\| 2026-11-02 10:00 \| abcdef1 Commit 2 \| success \| 0:38 \| 1 \|/);
});

test('a private repo reports the share used', () => {
    const now = new Date('2026-11-30T12:00:00Z');
    const runs = Array.from({ length: 30 }, (_, i) => run(i + 1, `2026-11-${String(i + 1).padStart(2, '0')}T08:00:00Z`, 70));
    const s = summarize(runs, { now, isPrivate: true });
    assert.equal(s.minutes, 60);
    assert.match(render(s), /private: these count against the plan's 2,000 included minutes \(\*\*3\.0% used\*\*\)/);
    assert.match(render(s), /and 10 earlier/);
});

test('an empty history renders', () => {
    const s = summarize([], { now: new Date('2026-11-15T12:00:00Z'), isPrivate: false });
    assert.equal(s.minutes, 0);
    assert.match(render(s), /0 deploys this month, 0 Actions minutes/);
});
