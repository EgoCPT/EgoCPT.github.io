# EgoCPT — anonymous ICRA submission

Project website for **EgoCPT: Learning Dexterous Manipulation from a Single
Ego-Centric Video with Contact-Aware Optimization**.

Author names and affiliations are omitted for double-blind review. Paper and
research code remain marked **coming soon**. The anonymous review page requests
that search engines not index it.

The page contains 11 interactive contact comparisons, three real-robot clips,
eight reconstructed trajectory clips, a policy montage, and the supplementary
video. Reconstructed videos and the supplementary video are native 1080p;
real-robot excerpts retain the approved source resolution and crop.

## Local preview

With Node.js 22 or later:

```sh
node scripts/verify_site.mjs
node scripts/serve.mjs
```

Open <http://127.0.0.1:8767/>. The `/anonymous-preview/` path exercises project
site routing. `PORT` and `PROJECT_PATH` can override these defaults.

Optional browser checks (Google Chrome and Node.js 22+):

```sh
node scripts/check_browser.mjs
```

Use `SITE_URL` to check another preview address. Screenshots and QA reports stay
in the ignored `_local/` directory.

## GitHub Pages

Set the repository's Pages source to **GitHub Actions**. The included workflow
validates and packages the website when `main` is updated. Only `index.html`,
`static/`, `.nojekyll`, and `THIRD_PARTY.md` enter the Pages artifact. Development
scripts, local review reports, and Git metadata are not served.

The repository uses a fresh history with anonymous commit attribution. Configure
repository access separately; never add SSH private keys or other credentials.

See [THIRD_PARTY.md](THIRD_PARTY.md) for template and media attribution.
