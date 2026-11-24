# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Sandivisi/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Sandivisi/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A dependency-free, drop-in replacement for makefun-site 1.0.0 that builds the same static site from the same input, byte for byte, much faster.

## Run it

```sh
node main.ts
```

## Files

- `solve.js` — the implementation. Exports `run(input)`, which returns the output tree (`{ path: text }`) for one case `{ site, templates, files }`: every page's `index.html`, the index and tag pages, `build-report.txt`, and every static file.
- `main.ts` — the harness driver. Reads `/input/cases.json` (or `$MAKEFUN_INPUT_DIR/cases.json`), answers each case with `run()`, and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR/answers.json`).

## How it works

- **Front matter** is parsed by a small hand-written parser implementing makefun-site's strict `key: value` grammar, with the same refusal reasons and check order as the reference.
- **Markdown** is rendered by a single-pass, hand-written renderer for makefun-site's own subset (fenced code, ATX headings with unique ids, thematic breaks, blockquotes, flat lists, paragraphs; inline code, strong, emphasis, links and backslash escapes). Inline text is rendered over string ranges, flushing plain runs in one piece, so long stretches of ordinary text cost almost nothing.
- **Templates** are parsed once into a small node tree (same dialect and error messages: `{{ }}`, `{{{ }}}`, `{% for %}`, `{% if %}`, `{% include %}`, standalone-tag line handling) and then compiled once per distinct template source into a small function that renders straight into a shared output array. Compiled templates are cached across cases in one process. Includes resolve through the same table at render time, with the 8-deep limit.
- **Slugs** follow makefun-site's rule (NFKD, combining marks dropped, runs of non-alphanumerics become one `-`, cut to 64) with a per-string cache, since titles and tag names repeat.
- **Links** are resolved to built pages or static files, with a per-run cache by (source directory, target); broken links are reported once each in `build-report.txt`, exactly as the reference does.

Node 22 standard library only; no dependencies, no network, no clock, no randomness — the output is a pure function of the input.

## License

MIT — see `LICENSE`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=gnkp9jxa&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
