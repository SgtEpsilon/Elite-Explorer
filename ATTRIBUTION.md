# Attribution

Elite Explorer is licensed GPL-3.0 (see `LICENSE`). This file credits
third-party data and projects used under license.

## Guardian Sites — survey geometry

The Guardian ruin/structure POI layouts in `data/guardianSiteTemplates.json`,
and the known-site bootstrap list in `data/guardianKnownSites.json`, are
derived from surveyed data originally published by the **SrvSurvey** project:

- Project: https://github.com/njthomson/SrvSurvey
- Author: njthomson and contributors
- License: GPL-3.0

SrvSurvey and Elite Explorer share the same license (GPL-3.0), which permits
this reuse. The data was converted — not copied verbatim — into Elite
Explorer's own schema, POI taxonomy, obelisk-grouping logic, and
local-to-world bearing convention; see
`scripts/convert-guardian-templates.js` for the exact transform and
`docs/guardian-sites-schema.md` for the resulting schema. The underlying
survey measurements (which obelisk sits where, relative to a site's origin)
are SrvSurvey's community-contributed work and are credited here per GPL-3.0
§5(a)/(b).

Elite Explorer's own code that consumes this data
(`engine/services/guardianTemplateService.js`,
`engine/services/guardianSitesService.js`, `ui/guardian-script.js`) is an
original implementation.

## Canonn Research

`engine/services/canonnClient.js` is an original client for Canonn
Research's public API (https://docs.canonn.tech), used as a fallback data
source for Guardian site types not yet covered by the local dataset above.
Canonn's server software is GPL-3.0; this client only consumes their public
HTTP API response data and contains no code derived from Canonn's own
codebase.
