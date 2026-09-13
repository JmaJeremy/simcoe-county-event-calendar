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
community name, 65 of 2,295 listings (mostly SPACES) still have `municipalitySlug = null`
— 36 events after clustering. They are treated as compatible with any municipality by
dedup, and the site now offers them under a "Not specified" option in the municipality
menu (`m=unspecified`, which the API turns into `municipality_slug IS NULL`).

Two things worth knowing about that bucket. A news site's own town is not used as a
default, deliberately: OrilliaMatters carries events from across the region, and a wrong
default would both mislabel them and let dedup bridge two towns. And because the
gazetteer can only reject what it can place, a few out-of-county listings survive there
(a Thornbury market, a Tobermory retreat) where a placed CitySpark row would have been
dropped.

## 6. BradfordToday is disabled

`bradford.spaces.ca` answered 503 throughout research. The registry row exists with
`enabled: false`; flip it when the host responds.

## 7. The Claude judge, first production run

The secret was set on 2026-09-13 and the judge ran for the first time: 49 ambiguous pairs
in 5 calls, 27 merged, 22 kept apart, none left unresolved. Verdicts read sensibly — the
same farmers' market from a town and a news site, the same ghost tour syndicated to three
Village Media sites. One merge crossed dates, a three-day Wasaga Beach blues festival the
town dated Sept 20 and CollingwoodToday dated Sept 18; that is the call the rules
deliberately defer, and merging one festival is the answer we want, but cross-date merges
are the shape to watch if false positives ever appear.

Cost is small and self-limiting: a verdict is cached per pair per content hash, so a
steady-state run judges only newly ambiguous pairs.

## 8. Syndicated news-site listings

Village Media pushes the same organiser-submitted listing to all four SPACES instances
(BarrieToday, OrilliaMatters, MidlandToday, CollingwoodToday), so one event can arrive as
four listings with no municipality. They merge with each other and, when a town also lists
the event, with the town's copy — but a generic listing ("National Day for Truth and
Reconciliation") is compatible with every town's ceremony that morning and lands with
whichever it scores best against. The municipality guard stops it bridging two towns.

## 9. Same-source duplicates are never merged, by design

Candidate pairs are only ever formed across different sources: a source's own repeats are
separate occurrences by construction. SPACES organisers do double-post, though — the
"Romance of the Violin" concert on BarrieToday appears once as an all-day listing and once
at 2:30 p.m., with different post ids — and both reach the site. Merging within a source
would risk collapsing a weekly series; a narrower rule (same source, same day, near-identical
title, one all-day and one timed) is the likely fix.
