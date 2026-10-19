# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Overview

Table-side tablet ordering system for family restaurants (UI text is Japanese). The backend uses only the Python standard library (`http.server` + `sqlite3`) and the frontend is plain HTML/CSS/ES modules with no build step. Do not add third-party dependencies (pip packages, npm, bundlers) unless explicitly asked; the machine this was built on has no Node.js.

## Commands

```sh
python server.py                      # serve on 0.0.0.0:8000, DB at data/insyoku.db
python server.py --reset              # delete DB and re-seed from db.py
python server.py --port 8765 --db /tmp/x.db
python -m unittest                    # all tests (run from repo root)
python -m unittest tests.test_api.OrderFlowTest.test_cannot_seat_twice   # single test
```

Tests start a real `OrderServer` on port 0 with a temp DB and talk to it over HTTP; there are no unit-level mocks.

## Architecture

- `server.py`: HTTP layer. Routes `/api/events` to SSE, `/api/*` to `api.py`, and everything else to static files in `static/` (`/`, `/table`, `/kitchen`, `/staff` are aliases for the `.html` pages). Each API request opens its own SQLite connection and runs the handler inside `with conn:` (commit on success, rollback on exception). `sqlite3.IntegrityError` becomes 409. Content types are hard-coded because Windows `mimetypes` can serve `.js` as `text/plain`.
- `api.py`: all business logic plus the `ROUTES` table. Handlers take a `Context` (`conn`, `params`, `body`) and return JSON-able data or raise `ApiError(status, message)`; messages are shown to users, so write them in Japanese.
- `db.py`: schema, connection setup (`foreign_keys` on, WAL), and seed data (8 tables and the menu). There are no migration files. When adding a column, also add it to `_migrate()` (`ALTER TABLE` if missing) so existing `data/insyoku.db` files keep working.

### Realtime model

Mutating handlers call `ctx.emit(type, **data)`. `server.py` publishes those events through `EventBus` to every SSE subscriber **only after the transaction commits**. Events carry no state, only a hint (`table` with `table_id`, `kitchen`, `calls`, `menu`). Clients react by re-fetching over REST. `subscribe()` in `static/common.js` also fires `{type: 'connected'}` on every (re)connect so clients do a full refresh and never miss updates. When adding a mutation, emit every event type whose screen shows the changed data.

### Domain rules

- A **session** is one visit (seated → checkout complete). A partial unique index allows only one open session (`closed_at IS NULL`) per table. Closing it resets the tablet to the welcome screen.
- Table status is derived, not stored: `vacant` (no open session), `checkout` (`checkout_requested_at` set; new orders are rejected), otherwise `occupied`.
- `order_items` copies `name` and `unit_price` at order time; totals come from these copies and exclude `cancelled` items.
- Item status changes must follow `STATUS_TRANSITIONS` in `api.py`. The kitchen queue only shows `pending`/`cooking` items from open sessions.
- `menu_items.recommended` drives the tablet's virtual 「本日のおすすめ」 section, which is built client-side in `menuSections()` in `table.js` and always listed first. `PATCH /api/menu/{id}` updates only the given fields (`sold_out` and/or `recommended`).
- Personal recommendations: after seating, the tablet asks for the representative's age group and gender (optional; saved on `sessions.age_group`/`gender` via `POST /tables/{id}/profile`). `recommend()` in `api.py` scores items as tag affinity (`menu_items.tags` × `AGE_TAG_WEIGHTS` + `GENDER_TAG_WEIGHTS`) + popularity among past sessions with the same profile + the staff `recommended` flag. It skips sold-out items, caps results at `MAX_RECOMMENDATIONS` with at most `MAX_PER_CATEGORY` per category, and never recommends `alcohol`-tagged items to `MINOR_AGE_GROUPS`. Keep that rule when changing scoring. Age/gender option keys are duplicated in `common.js` (`AGE_OPTIONS`, `GENDER_OPTIONS`). Seed tags live in `db.MENU_ITEM_TAGS`. There is no UI for editing tags yet.
- Allergies: `api.ALLERGENS` (key → label, display order) is the single source. `/api/menu` returns it as `allergens` for the frontends. `menu_items.allergens` holds what each item contains (seeded from `db.MENU_ITEM_ALLERGENS`). `sessions.allergens` holds what the guests avoid (`POST /tables/{id}/allergens`), so it resets at checkout. The tablet hides matching items from every section and blocks ordering them. `recommend()` excludes them. Kitchen tickets and the staff screen show the table's allergies.
- Calls: `staff`/`water` come from `POST /tables/{id}/calls` and are deduplicated while unresolved. A `checkout` call is created only by `checkout-request`. Closing a session resolves all of the table's calls.

### Frontend

Each page has a matching `<page>.js` module and imports helpers from `common.js` (`api`, `el`, `subscribe`, `serialized`, `toast`, `storage`). Build DOM with `el()` (text nodes, no `innerHTML`). Re-fetches are wrapped in `serialized()` so bursts of events don't overlap. The tablet stores its table id and its unsent cart in `localStorage` (`tableId`, `cart:<id>`). Calls to `localStorage` go through `storage`, which tolerates it being unavailable.

The visual theme is black with gold accents and Mincho (serif) type. Design tokens (`--gold`, `--surface`, `--serif`, …) live in `static/style.css`. Fonts come only from what is installed on the device (no web fonts) so the UI works offline. The kitchen screen uses `--sans` for readability.

There is no authentication on any screen. The app is designed for a closed in-store network.
