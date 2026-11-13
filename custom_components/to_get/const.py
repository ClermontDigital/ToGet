"""Constants for To Get."""
from __future__ import annotations

DOMAIN = "to_get"

CONF_NAME = "name"
CONF_ICON = "icon"

DEFAULT_NAME = "To get"
DEFAULT_ICON = "mdi:cart-outline"

MAX_SUMMARY = 120               # what's needed
MAX_PLACE = 60                  # where it's coming from
MAX_NOTES = 500
MAX_OPEN = 500                  # things still to get, on one list
MAX_GOT = 200                   # got things kept (the oldest go first)
MAX_KNOWN = 300                 # things remembered, with the place they came from last
MAX_PLACES = 40                 # places offered as suggestions
FIRST_FEW = 5                   # names in the summary, for the count strip

STATUS_OPEN = "needs_action"    # the same words as Home Assistant's to-do lists
STATUS_GOT = "completed"

CARD_FILENAME = "to-get-card.js"
CARD_URL = f"/{DOMAIN}/{CARD_FILENAME}"

SIGNAL_UPDATED = f"{DOMAIN}_updated_{{}}"   # format with entry_id
SIGNAL_ANY = f"{DOMAIN}_any_updated"        # any list changed, was added or went away

SERVICE_ADD = "add"
ATTR_ITEM = "item"
ATTR_PLACE = "place"
ATTR_NOTES = "notes"
