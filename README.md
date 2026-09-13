# viral-outliers

Official command-line tool for the [Viral Outliers](https://viraloutliers.com) API: search statistically overperforming TikTok, Instagram and YouTube posts, transcribe and visually analyze them, crawl and monitor profiles, and remix winners into your own niche.

Zero runtime dependencies. Node 20 or newer.

## Install

```sh
npm i -g viral-outliers
viral-outliers --version

# or without installing
npx viral-outliers commands
```

## Log in

Create an API key at https://viraloutliers.com/settings?tab=api-keys, then:

```sh
viral-outliers login --key so_live_...
```

The key is validated against the API (a free balance check) before it is saved to a config file with owner-only permissions.

Key precedence for every call:

1. `--key so_live_...`
2. the `VIRAL_OUTLIERS_API_KEY` environment variable
3. the config file written by `login` (`$XDG_CONFIG_HOME/viral-outliers/config.json`, `%APPDATA%\viral-outliers\config.json` on Windows, else `~/.config/viral-outliers/config.json`; `VIRAL_OUTLIERS_CONFIG` overrides the full path)

Without a key the request is still sent: the server's reply tells you how to get one. `viral-outliers logout` deletes the saved key.

## Examples

```sh
# Outlier posts in a niche, TikTok only, at least 5x the creator's baseline
viral-outliers search-outliers --query "cold plunge" --platforms tiktok --min-outlier-score 5

# One post with its cached transcript, skipping the visual analysis
viral-outliers get-post <post-id> --no-include-visual-analysis

# Remix a viral post into your niche and wait for the result
viral-outliers remix-post --url https://www.tiktok.com/@creator/video/123 \
  --target-niche "B2B SaaS founders selling analytics tools" --wait
```

`viral-outliers commands` lists every command with its credit cost; `viral-outliers help <command>` shows the flags. Flags are the API's parameter names in kebab-case (`--min-outlier-score`), list values can be repeated or comma-separated (`--platforms tiktok,instagram`), handle pairs are `--handles tiktok:creator`, and `--body '{"query":"x"}'` merges raw JSON over the flags.

## Output

- Success: the JSON response on stdout (pretty on a terminal, single-line when piped or with `--compact`).
- Billed calls print `credits: charged=N balance=M` on stderr (`--quiet` silences it).
- Errors: the API's JSON error on stderr plus a hint (log in, top up, pay link).

## `--wait`

Asynchronous commands (`request-transcript`, `request-visual-analysis`, `crawl-profile`, `download-post-media`, `remix-post`) return a job reference. Add `--wait` to have the CLI poll the free status endpoint (`--poll-interval`, default 10 s; `--timeout`, default 900 s) and print the finished result: the post with its transcript or analysis (one `get-post` call, 1 credit), the crawl outcome, the media URLs (the documented collect call, billed again), or the finished remix. The CLI never resubmits a billed request because a job is slow.

## Exit codes

| code | meaning |
| ---- | ------- |
| 0 | success |
| 1 | error (server error, not found, invalid params, network, timeout) |
| 2 | payment required (out of credits or no account yet) |
| 3 | rate limited |
| 4 | authentication failed (missing or rejected API key) |
| 5 | usage error (unknown command or flag, missing required flag) |

## Development

`src/manifest.json` is generated from the Viral Outliers skill registry by the main application and must not be edited by hand: every command, flag, cost and route in this CLI comes from it. `npm run build` compiles to `dist/`, `npm test` runs the vitest suite (no network).

Full documentation: https://viraloutliers.com/docs/cli
