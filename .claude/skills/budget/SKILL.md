---
name: budget
description: Read and (with confirmation) edit the user's personal budget Google Sheet – planned revenue, recurring needs, annual costs, and their totals. Use for questions about the budget or requests to add, change, or remove budget entries. Actual spending and balances come from the bank reader, not this sheet.
---

# Budget

Plain `curl` against the Google Sheets API v4, `jq` for JSON processing.

## Access

Spreadsheet ID: `1YLMFgg_fBi-t_tg0g4fZW4AKvX8LB-yeCjA4O77W2k8` (owned by the user's personal Google account).

The credential broker signs in as the `wicek-budget@wicek-511922.iam.gserviceaccount.com` service account,
which has Editor access to this one spreadsheet, so there is no auth step:

```bash
SHEET=https://sheets.googleapis.com/v4/spreadsheets/1YLMFgg_fBi-t_tg0g4fZW4AKvX8LB-yeCjA4O77W2k8
curl -s "$SHEET?fields=sheets.properties"
```

The broker only allows paths under this spreadsheet: any other spreadsheet returns 403. A 403 from Google
itself (`PERMISSION_DENIED`) means the sheet is no longer shared with the service account – ask the user to
share it again as Editor.

## Reading

- Sheet names and sizes: `GET $SHEET?fields=sheets.properties(title,sheetId,gridProperties)`
- Values: `GET $SHEET/values/<range>` (e.g. `Sheet!A1:H40`) – add `valueRenderOption=FORMULA` to see
  formulas instead of results
- Several ranges: `GET $SHEET/values:batchGet?ranges=<range>&ranges=<range>`

URL-encode ranges with spaces or `!` (`--data-urlencode` with `-G`). Read the layout first – the sheet has
several sections side by side (revenue, needs, annual costs), each with its own header row and totals.

## Writing

Before any write, read the target range with `valueRenderOption=FORMULA`, then show the user the cells you
will change (old → new) and wait for their OK. A direct request with exact values ("add Netflix, €12.99, on
the 5th") counts as the OK. Never overwrite a formula cell (totals, currency conversions) unless the user
asks for that specific cell.

- Update cells: `PUT $SHEET/values/<range>?valueInputOption=USER_ENTERED` with `{"values": [[...]]}`
- Insert rows inside a section: `POST $SHEET:batchUpdate` with an `insertDimension` request
  (`inheritFromBefore: true`), then write the new row, so the section's sum formulas expand to include it
- Clear cells: `POST $SHEET/values/<range>:clear`

Use `USER_ENTERED` so numbers, dates, and formulas are parsed as if typed. After writing, read the section's
totals back and report them. Every edit is listed in the sheet's version history under the service account,
so the user can revert from there.
