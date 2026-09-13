# Known issues

Deferred deliberately. Each has been measured against the live sources rather than
estimated (full dry run, 2026-09-13: 2,295 listings from 25/25 sources, 322 HTTP requests,
~55 s).

## 1. Recurring drop-in programs dominate some sources

Essa alone contributes 574 listings — daily drop-in pickleball, walking groups, family
basketball — every one `cost: unknown`. Bradford (156) and Penetanguishene (130) are
similar. De-duplication handles them correctly (same title on different dates are
different events), but the list view will be swamped unless it groups repeats of the same
title within a source ("Pickleball Drop-in · 14 more dates"). Do this in SCEC-19.

## 2. Half the platforms encode content in the listing id

govStack (detail slug), Drupal rows (`path@datetime`) and SPACES (`dataId@startDate`) give
no id that survives an edit. A retitled or rescheduled event there becomes a new listing;
the old one goes `active = false` and its cluster is hidden. Its short link stops resolving
to a visible event. Accepted: the alternative (content-hash matching across runs) is the
bug civi-times' predecessor had. The de-duplicator may re-merge the new listing with copies
on other sources, so the event usually survives under a different short code.

## 3. EventON costs ~8 requests per listing

The County of Simcoe calendar needs the WP REST list (1 request) plus one page per post
published in the last 13 months (52) to yield 9 in-window listings; Adjala-Tosorontio, 49
requests for 5. Fine inside the budget (113 of 322), but the first thing to cache by
`modified` once ingest keeps state.

## 4. CitySpark detail URLs are inferred

`https://www.simcoe.com/events/#/details/{slug}/{PId}` is the portal's usual hash route
and has not been verified in a browser. If it does not resolve, prefer `PrimaryUrl` when
the row has one.

## 5. SPACES listings often have no municipality

Village Media listings are organiser-typed free text. After reading the description for a
community name, 65 of 2,295 listings (mostly SPACES) still have `municipalitySlug = null`.
They are shown county-wide and treated as compatible with any municipality by dedup.

## 6. BradfordToday is disabled

`bradford.spaces.ca` answered 503 throughout research. The registry row exists with
`enabled: false`; flip it when the host responds.
