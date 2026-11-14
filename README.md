# Arrowverse Tracker

Every Arrowverse episode in watch order, with a Material You interface. Swipe an episode right to mark it watched, or left to unmark it.

**Live:** https://gray30000000.github.io/arrowverse-tracker/

## Features
- Watch order taken from [arrowverse.info](https://arrowverse.info), with crossovers in the right place
- Swipe gestures with haptics, undo snackbar, and "mark everything up to here"
- Episode details (summary, runtime, rating, still) from [TVmaze](https://www.tvmaze.com)
- Filter by series, unwatched-only view, search, progress per series
- Material 3 light/dark themes with six color schemes
- Installable PWA that works offline. Progress is stored on the device, with backup and restore.

## Data
`scripts/build-data.mjs` runs in the Pages workflow (on every push and weekly). It takes the order from arrowverse.info's API, matches each row to a TVmaze episode, and writes `data.json` plus `report.json`, which lists every place the two sources disagree. If arrowverse.info is down, the build falls back to TVmaze broadcast-time order. If `data.json` is missing, the app loads from TVmaze directly.

Each character in `characters.json` has an `imageUrl`: the portrait from their wiki page, as a URL on the wiki's image CDN, or `null`. Characters only get one when their wiki page title is the name they're first credited with, so a portrait can't reveal a secret identity early; the rest show initials. Portrait lookups are cached for 30 days, and `report.json` counts them under `characters.images`.

Series: Arrow, The Flash, Constantine, Vixen, Supergirl, Legends of Tomorrow, Freedom Fighters: The Ray, Black Lightning, Batwoman, Stargirl, Superman & Lois.
