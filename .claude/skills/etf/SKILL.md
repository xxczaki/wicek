---
name: etf
description: Weekly ETF data for DFEU.AS and SEC0.DE – Friday vs prior Friday close from the Yahoo chart API, and iShares full-holdings snapshots with week-over-week allocation diffs. Use for the weekly ETF recap or any question about these funds' prices or holdings.
---

# ETF data (Yahoo chart API + iShares holdings)

A dependency-free Node script. All output is JSON on stdout.

```
node /app/.claude/skills/etf/etf.mjs weekly
```

Commands (all accept `--fund DFEU|SEC0`; default is both):
- `weekly` – `prices` + `holdings` in one call. Use this for the recap.
- `prices [--date YYYY-MM-DD]` – the week's Friday close vs the prior Friday close,
  the close timestamp, the week's daily closes, and `warnings`.
- `holdings [--date YYYY-MM-DD] [--dry-run]` – downloads the full holdings CSV,
  saves it to `/data/etf/holdings/<fund>/<as-of date>.csv`, and diffs it against
  the newest snapshot that is at least 5 days older. If none exists, it backfills
  last week's snapshot from iShares. `--dry-run` skips writing.

Reading the output:
- `prices.close.final: false` – Friday's official close isn't published yet.
  The price is the last intraday quote; call it provisional. `warnings` explains it.
- `holdings.weightChanges` – weight moves ≥ 0.2 pp, mostly price drift.
- `holdings.rebalanced` – share count changed vs fund flows. This is an actual
  allocation change (index rebalance, cap adjustment).
- `holdings.entries` / `exits` – new or removed constituents.
- `holdings.splits` – share-count jumps due to stock splits (not reallocations).
- `holdings.movers` – holdings ranked by weight × move (`contributionPp`) between
  the two snapshots, in fund currency. Use these to target news searches.

Sources:
- Prices: `https://query1.finance.yahoo.com/v8/finance/chart/<symbol>?range=1mo&interval=1d`
  (query2 fallback; needs a browser User-Agent).
- Holdings: iShares "Detailed Holdings and Analytics" download –
  `https://www.blackrock.com/varnish-api/uk-retail01-product-data/product-data/api/v1/get-fund-document?appType=PRODUCT_PAGE&appSubType=ISHARES&targetSite=ishares-uk&locale=en_GB&userType=individual&component=holdings&portfolioId=<id>[&asOfDate=YYYYMMDD]`
  - DFEU – portfolioId 343289, ISIN IE000IAXNM41,
    https://www.ishares.com/uk/individual/en/products/343289/ishares-europe-defence-ucits-etf
  - SEC0 – portfolioId 319084, ISIN IE000I8KRLL9,
    https://www.ishares.com/uk/individual/en/products/319084/ishares-msci-global-semiconductors-ucits-etf
