#!/usr/bin/env node
/* Deploy usage log: how much GitHub Actions time the site deploys are using.

   Runs as the last step of .github/workflows/deploy-site.yml and writes a
   month-to-date table to that run's summary page (Actions tab → the run):
   one line per recent deploy with its duration and the minutes GitHub
   counts for it, then the month's total against the plan's allowance.

   GitHub rounds each job up to a whole minute, so a 35-second deploy
   counts as 1. Standard runners are free and uncapped for a public
   repository; the allowance only applies while the repo is private, and
   this says which case it is on every run.

   Durations are read from the workflow's run history (start of run to
   last update), which includes time spent waiting for a runner, so the
   totals are an upper bound on what is billed. It never fails the deploy:
   any error here is reported as a warning. */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

export const billedMinutes = (seconds) => Math.max(1, Math.ceil(seconds / 60));

/* runs: the `workflow_runs` array from the Actions API (any order). */
export function summarize(runs, { now, isPrivate, includedMinutes = 2000, currentRunId = null }) {
    const nowMs = now.getTime();
    const month = now.toISOString().slice(0, 7);
    const rows = runs
        .filter((r) => (r.run_started_at || r.created_at || '').slice(0, 7) === month)
        .map((r) => {
            const start = Date.parse(r.run_started_at || r.created_at);
            const running = r.status !== 'completed';
            const end = running ? nowMs : Date.parse(r.updated_at);
            const seconds = Math.max(0, Math.round((end - start) / 1000));
            return {
                id: r.id,
                started: new Date(start).toISOString(),
                commit: (r.head_sha || '').slice(0, 7),
                title: (r.display_title || '').slice(0, 60),
                result: running ? (r.id === currentRunId ? 'this run' : 'running') : (r.conclusion || 'unknown'),
                seconds,
                minutes: billedMinutes(seconds),
            };
        })
        .sort((a, b) => b.started.localeCompare(a.started));
    const minutes = rows.reduce((t, r) => t + r.minutes, 0);
    const day = now.getUTCDate();
    const daysInMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)).getUTCDate();
    const projected = Math.round(minutes * daysInMonth / day);
    return { month, rows, deploys: rows.length, minutes, projected, isPrivate, includedMinutes,
             share: isPrivate ? minutes / includedMinutes : 0 };
}

export function render(s) {
    const mmss = (sec) => Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    const lines = [
        `### Deploy usage, ${s.month}`,
        '',
        `**${s.deploys} deploy${s.deploys === 1 ? '' : 's'} this month, ${s.minutes} Actions minute${s.minutes === 1 ? '' : 's'}** ` +
        `(on pace for about ${s.projected} by month end).`,
        '',
        s.isPrivate
            ? `This repository is private: these count against the plan's ${s.includedMinutes.toLocaleString('en-US')} included minutes ` +
              `(**${(100 * s.share).toFixed(1)}% used**).`
            : 'This repository is public: standard runners are free and uncapped, so none of this is charged. ' +
              `If the repo were private it would be ${(100 * s.minutes / s.includedMinutes).toFixed(1)}% of the ` +
              `${s.includedMinutes.toLocaleString('en-US')} minutes included with GitHub Free.`,
        '',
        '| Started (UTC) | Commit | Result | Duration | Minutes counted |',
        '|---|---|---|---:|---:|',
        ...s.rows.slice(0, 20).map((r) =>
            `| ${r.started.slice(0, 16).replace('T', ' ')} | ${r.commit} ${r.title.replace(/\|/g, '/')} | ${r.result} | ${mmss(r.seconds)} | ${r.minutes} |`),
        s.rows.length > 20 ? `| …and ${s.rows.length - 20} earlier | | | | |` : null,
        '',
        'Each deploy is one job and GitHub rounds a job up to a whole minute. Durations include time queued for a runner, so this is an upper bound.',
        '',
    ];
    return lines.filter((l) => l !== null).join('\n');
}

async function fetchRuns({ repo, workflow, token, since, api = 'https://api.github.com' }) {
    const runs = [];
    for (let page = 1; page <= 10; page++) {
        const url = `${api}/repos/${repo}/actions/workflows/${workflow}/runs?per_page=100&page=${page}` +
                    `&created=${encodeURIComponent('>=' + since)}`;
        const res = await fetch(url, { headers: {
            authorization: `Bearer ${token}`,
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
        } });
        if (!res.ok) throw new Error(`GitHub API ${res.status} listing workflow runs`);
        const batch = (await res.json()).workflow_runs || [];
        runs.push(...batch);
        if (batch.length < 100) break;
    }
    return runs;
}

async function main() {
    const env = process.env;
    const now = new Date();
    const runs = await fetchRuns({
        repo: env.GITHUB_REPOSITORY,
        workflow: env.USAGE_WORKFLOW_FILE || 'deploy-site.yml',
        token: env.GITHUB_TOKEN,
        since: now.toISOString().slice(0, 7) + '-01',
        api: env.GITHUB_API_URL,
    });
    const s = summarize(runs, {
        now,
        isPrivate: env.REPO_PRIVATE === 'true',
        includedMinutes: Number(env.INCLUDED_MINUTES) || 2000,
        currentRunId: Number(env.GITHUB_RUN_ID) || null,
    });
    const report = render(s);
    console.log(report);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, report + '\n');
    // Only a private repo has an allowance to run out of.
    if (s.isPrivate && s.share >= 0.5) {
        console.log(`::warning::Site deploys have used ${(100 * s.share).toFixed(0)}% of this month's included Actions minutes.`);
    }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    main().catch((e) => {
        console.log(`::warning::Deploy usage log unavailable: ${e.message}`);
    });
}
