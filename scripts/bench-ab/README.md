# bench-ab

A/B benchmark of `@vue/reactivity` between two revisions: time, kernel work,
memory and size. It runs on CI (`.github/workflows/bench-ab.yml`) so that no
result rests on one developer machine; every part also runs locally.

## On CI

The workflow runs on pushes to `quant-kernel` that touch the kernel or these
scripts, and by hand (Actions → bench-ab → Run workflow) with:

- `base`: the base revision, by default `1a5397ae1` (Vue 3.6 `minor` with
  the alien-signals kernel)
- `head`: the head revision, by default the commit of the run
- `rounds`: ABBA rounds per workload and replica (default 5)

Jobs:

| job | what | machine dependent |
| --- | --- | --- |
| bundles | builds both production bundles from their commits, checks that every workload computes the same on both (`verify.js`), measures size (`sizes.js`) | no |
| timing | 4 shards of workloads × 3 replicas; each job times its shard on its own runner | yes, within a job |
| counts | kernel work per step from source (`counts.js`) | no |
| memory | heap per node and link, churn, minor-GC promotion (`scripts/reactivity-mem`) | barely |
| report | one summary (`aggregate.js`), on the run page and as the `bench-report` artifact | — |

### Reading the time table

Hosted runners differ from job to job, often in CPU model, so a ratio is
only valid inside the job that measured it; absolute ops/s are never
compared across jobs or runs. Inside a job:

- every sample runs in a fresh process pinned to one CPU (`taskset`);
- samples alternate base, head, head, base (ABBA), so drift cancels;
- the ratio's 95% interval is a bootstrap over rounds;
- the noise is the ratio between the two base samples of each round: a
  change counts only beyond it.

A workload is **faster** or **slower** only if every replica says so;
replicas that disagree make it **unstable**, and a verdict on some of them
only reads e.g. `slower on 2/3`. The ratio shown is the geometric mean over
replicas. The `failure.*` workloads do different work on the two kernels
(the base serves stale values after a failure, the head runs again), so
they have no verdict.

### Exact parts

Counts (runs, reads, links allocated and removed, scans, index walks, push
and pull visits, allocations per step) do not depend on the machine: they
are what a CI gate can compare exactly. A base kernel without counters
(alien-signals) gets them from `counters-shim.js` in a throwaway worktree;
every edit of the shim must match exactly once, so a changed kernel fails
loudly instead of being counted wrong.

## Locally

```sh
# time: two revisions (built in worktrees), or two bundle files
node scripts/bench-ab 1a5397ae1 worktree --rounds 5 [--filter re] [--cores auto|none|2,8]
# the bundles CI uses, then the rest of its jobs on them
node scripts/bench-ab/prepare.js 1a5397ae1 HEAD --out temp/bench-ab/prepared
node scripts/bench-ab/verify.js temp/bench-ab/prepared/base.js temp/bench-ab/prepared/head.js
node scripts/bench-ab/sizes.js temp/bench-ab/prepared/base.js temp/bench-ab/prepared/head.js
node scripts/bench-ab/counts.js --base 1a5397ae1
node scripts/reactivity-mem --base temp/bench-ab/prepared/base.js --head temp/bench-ab/prepared/head.js
node scripts/bench-ab/aggregate.js --timing temp/bench-ab/report --counts temp/bench-ab/counts/counts.json
```

On a hybrid processor (P and E cores) `--cores auto` times each class
separately on Linux; on Windows pass the CPUs (`--cores 2,8`). Compare
ratios only within one run.

## Workloads

`workloads.js`: each `setup` builds a graph outside the measured region and
returns one step. Groups: tracking (`stable`, `rotate`, `swap`, `shuffle`,
`shared-shuffle`), lifecycle (`first-run`, `branch`), propagation
(`write-read`, `fan-out`, `fan-in`, `chain`, `diamond`), failure, and
real-ish apps (`real.*`: a todo list, components on effect scopes, a deep
watcher, a keyed list).
