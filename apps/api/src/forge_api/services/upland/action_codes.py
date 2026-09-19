"""Obfuscated Upland action names -> human meaning.

Ported from the upland-scraper `action_codes.py`. `confidence` is how sure we are
of the decoded meaning (0-1); `category` groups actions for analytics.
"""

from typing import TypedDict


class ActionInfo(TypedDict):
    meaning: str
    confidence: float
    category: str


ACTION_MAP: dict[str, ActionInfo] = {
    # --- Property trading (buy/sell/list/offer) ---
    "n5": {"meaning": "secondary market property buy", "confidence": 1.0, "category": "trade"},
    "n2": {"meaning": "list property for sale", "confidence": 0.65, "category": "trade"},
    "n4": {"meaning": "unlist property", "confidence": 0.65, "category": "trade"},
    "n12": {"meaning": "make offer", "confidence": 0.65, "category": "trade"},
    "n14": {"meaning": "reject offer", "confidence": 0.45, "category": "trade"},
    "n15": {"meaning": "cancel own offer", "confidence": 0.45, "category": "trade"},
    "n13": {"meaning": "offer swap settlement", "confidence": 1.0, "category": "trade"},
    "n111": {
        "meaning": "offer acceptance property settlement",
        "confidence": 0.9,
        "category": "trade",
    },
    "n52": {"meaning": "property handoff claim", "confidence": 0.65, "category": "trade"},
    # --- Property minting / definition ---
    "a4": {"meaning": "fsa property purchase (mint)", "confidence": 1.0, "category": "mint"},
    "a44": {"meaning": "fsa property purchase", "confidence": 0.9, "category": "mint"},
    "i44": {"meaning": "fsa property purchase", "confidence": 0.9, "category": "mint"},
    "i4": {"meaning": "fsa property purchase", "confidence": 0.0, "category": "mint"},
    "a31": {"meaning": "define or mint property", "confidence": 0.65, "category": "mint"},
    "a41": {"meaning": "define property metadata", "confidence": 0.65, "category": "mint"},
    "addcol": {"meaning": "define collection", "confidence": 0.65, "category": "mint"},
    "revealcol": {"meaning": "reveal collection", "confidence": 0.25, "category": "mint"},
    # --- Spark / staking ---
    "a32": {"meaning": "spark unstake from structures", "confidence": 1.0, "category": "spark"},
    "n121": {"meaning": "spark unstake", "confidence": 1.0, "category": "spark"},
    "n511": {"meaning": "spark release on build", "confidence": 1.0, "category": "spark"},
    "n512": {"meaning": "spark unstake", "confidence": 1.0, "category": "spark"},
    # --- Earnings / yield ---
    "n24": {"meaning": "collect visit earnings", "confidence": 0.9, "category": "earnings"},
    "n31": {"meaning": "collect property yield", "confidence": 0.9, "category": "earnings"},
    "n142": {
        "meaning": "batch visit earnings distribution",
        "confidence": 0.9,
        "category": "earnings",
    },
    # --- Fees / admin ---
    "n41": {"meaning": "per property upx fee", "confidence": 0.65, "category": "fee"},
    "n43": {"meaning": "flat upx fee", "confidence": 0.65, "category": "fee"},
    "a25": {"meaning": "property fee or forfeit", "confidence": 0.65, "category": "fee"},
    "payforcpu": {"meaning": "pay user cpu", "confidence": 0.65, "category": "fee"},
    "n44": {"meaning": "fixed upx bonus grant", "confidence": 0.9, "category": "fee"},
    "n21": {"meaning": "set property appreciation bulk", "confidence": 0.65, "category": "fee"},
    # --- User / config ---
    "n33": {"meaning": "new user registration", "confidence": 0.9, "category": "user"},
    "n34": {"meaning": "user self action (ambiguous)", "confidence": 0.65, "category": "user"},
    "n51": {"meaning": "user self action (ambiguous)", "confidence": 0.65, "category": "user"},
    "n45": {"meaning": "set earnings rate parameter", "confidence": 0.65, "category": "config"},
    "n35": {"meaning": "buy ram resources", "confidence": 0.55, "category": "config"},
    "n131": {"meaning": "batch dispatcher", "confidence": 0.25, "category": "config"},
    "n134": {"meaning": "set season reward pool", "confidence": 0.65, "category": "config"},
    "n154": {"meaning": "define season window", "confidence": 0.65, "category": "config"},
    "n155": {"meaning": "batch parameter config", "confidence": 0.65, "category": "config"},
    "n1": {"meaning": "spark or token config", "confidence": 0.25, "category": "config"},
    # --- Admin / unknown ---
    "c": {"meaning": "admin custodial management", "confidence": 0.25, "category": "admin"},
    "n135": {"meaning": "admin register token contracts", "confidence": 0.45, "category": "admin"},
    "removetemp": {"meaning": "remove temp record", "confidence": 0.25, "category": "admin"},
    "n112": {"meaning": "nft decoration sale settlement", "confidence": 1.0, "category": "trade"},
}

#: Actions we care about most for market analysis (buy/sell/offer/listing)
MARKET_ACTIONS: list[str] = ["n5", "n111", "n13", "n112", "n12", "n2", "n4", "n14", "n15"]
#: Actions related to property minting
MINT_ACTIONS: list[str] = ["a4", "a44", "i44", "a31"]
#: Actions related to earnings
EARNINGS_ACTIONS: list[str] = ["n31", "n24", "n142"]
#: Actions related to spark
SPARK_ACTIONS: list[str] = ["a32", "n121", "n511", "n512"]
#: All trade-relevant actions
TRADE_RELEVANT: list[str] = MARKET_ACTIONS + MINT_ACTIONS + EARNINGS_ACTIONS + SPARK_ACTIONS

#: Contract accounts
CONTRACT_PLAYUPLAND: str = "playuplandme"
CONTRACT_UPX_TOKEN: str = "upxtokenacct"

#: Actions that carry a sale price (the `actions/sales` feed and CSV `sales` export).
SALE_ACTIONS: tuple[str, ...] = ("n5", "n111", "n13", "n112", "a4", "a44")
#: Secondary-market settlements used for daily volume and the price histogram.
VOLUME_ACTIONS: tuple[str, ...] = ("n5", "n111", "n13")
#: Every category `ACTION_MAP` can emit, plus the fallback for unmapped codes.
CATEGORIES: tuple[str, ...] = tuple(
    sorted({info["category"] for info in ACTION_MAP.values()} | {"unknown"})
)
