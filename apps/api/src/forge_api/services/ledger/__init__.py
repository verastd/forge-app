"""The Upland Ledger gateway (behind `upland_ledger`): `/api/ledger/*` forwards an allowlist
of the ledger's `/v1/*` routes to the ledger at UPLAND_LEDGER_URL. Self-contained:
`allowlist.py` (what may be reached) and `gateway.py` (how it is forwarded), with the thin
router in routers/ledger.py."""
