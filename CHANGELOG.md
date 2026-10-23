# Changelog

## 0.2.0
- Update check: Crew looks for a newer GitHub release at start and every 6 hours (quietly, if it can't reach GitHub). A button in the page header shows "Update available (vX)".
- One-click update from the PC Crew runs on. A git clone is fast-forwarded to the release; a zip install has the release files copied over it. `crew.config.json`, `data/`, `workspace/` and `.env` files are never touched.
- New endpoint `GET /api/update`.

## 0.1.0
- First public release.
