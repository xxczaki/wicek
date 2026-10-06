---
name: bank
description: Read the user's C24 bank accounts – balances and transactions – through the Enable Banking API (read-only). Use for spending questions, finding a payment, checking a balance, or summarizing transactions.
---

# Bank (C24 via Enable Banking)

Read-only account access (balances, transactions) through Enable Banking's PSD2 API at `https://api.enablebanking.com`.
The credential broker signs every request, so call it with plain `curl` and no auth:

```
curl -s https://api.enablebanking.com/aspsps?country=DE
```

## Session

Data calls need the user's account `uid`s, which come from a session. Keep the `session_id`, the account `uid`s (with IBAN and name), and the session's `valid_until` in memory.

If there is no session in memory, or a call returns 401/403 or a consent-expired error, set one up:

1. Find the bank and how long consent may last:
   `curl -s 'https://api.enablebanking.com/aspsps?country=DE' | jq '.aspsps[] | select(.name | test("C24"; "i")) | {name, country, maximum_consent_validity}'`
2. Start authorization. Set `valid_until` to now plus `maximum_consent_validity` seconds (at most 180 days):
   ```
   curl -s -X POST https://api.enablebanking.com/auth -H 'content-type: application/json' -d '{
     "access": {"valid_until": "<ISO 8601>"},
     "aspsp": {"name": "<name from step 1>", "country": "DE"},
     "state": "<random uuid>",
     "redirect_url": "https://parsify.eu/",
     "psu_type": "personal"
   }'
   ```
3. Send the user the returned `url`. They log in to C24, then land on `https://parsify.eu/?state=…&code=…`. Ask them to paste back the `code` value (or the whole URL).
4. Create the session: `curl -s -X POST https://api.enablebanking.com/sessions -H 'content-type: application/json' -d '{"code": "<code>"}'`. Save `session_id`, `accounts[]` and `access.valid_until` to memory.

When `valid_until` is within a week, remind the user that the bank connection needs renewing.

## Data

- Session and accounts: `GET /sessions/<session_id>`
- Account details: `GET /accounts/<uid>/details`
- Balances: `GET /accounts/<uid>/balances`
- Transactions: `GET /accounts/<uid>/transactions?date_from=YYYY-MM-DD[&date_to=YYYY-MM-DD]`. If the response has a `continuation_key`, repeat the call with `&continuation_key=<key>` until it is absent.

Transaction fields worth using: `booking_date`, `transaction_amount.amount`/`.currency`, `credit_debit_indicator` (`DBIT` is money out, `CRDT` is money in), `creditor.name`, `debtor.name`, `remittance_information[]`, `status` (`BOOK` booked, `PDNG` pending).

## Notes

- Banks rate-limit unattended access (often 4 calls per account per day under PSD2). Fetch a wide date range once and work from the saved JSON in `/data/tmp/` instead of calling repeatedly.
- This is the user's real financial data. Don't send it anywhere except back to the user.
