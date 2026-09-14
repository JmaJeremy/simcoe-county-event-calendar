# Names and domains

**Decided 2026-09-13: the site is Out in Simcoe, at https://outinsimcoe.ca.** Jeremy
registered the domain; it is a custom domain on the `scec-web` worker alongside
`www.outinsimcoe.ca`, which redirects to the apex. The workers.dev host still answers as a
fallback. What follows is the shortlist the choice came from, kept for the record.

The site previously shipped under the placeholder **Simcoe County Events** on `scec-web.thejeremy-net.workers.dev`.
Nothing in the code depends on the name except the wordmark in `apps/web/public/index.html`,
`SITE_NAME` in `apps/web/src/worker.ts`, the manifest, and the card that `scripts/brand.ts`
renders — a rename is those four files and one script run.

## Availability

Checked 2026-09-13 with RDAP (`https://rdap.org/domain/<name>`), calibrated against
`civi-times.ca` and `google.com`, which both came back registered. A 404 there means no
registration exists today; it does not promise a registrar will sell it at base price, and
it is a snapshot that goes stale. Re-check before buying.

| Name | Domain | .ca | .com |
|---|---|---|---|
| Out in Simcoe | outinsimcoe | free | free |
| Simcoe Events | simcoeevents | free | free |
| Simcoe Days | simcoedays | free | free |
| What's On Simcoe | whatsonsimcoe | free | not checked |
| Simcoe County Events | simcoecountyevents | free | not checked |
| Between the Bays | betweenthebays | free | not checked |
| Do Simcoe | dosimcoe | free | not checked |
| Free in Simcoe | freeinsimcoe | free | not checked |
| Happening in Simcoe | happeninginsimcoe | free | not checked |
| County Events | countyevents | free | not checked |
| Simcoe Weekend | simcoeweekend | free | not checked |
| Simcoe Now | simcoenow | taken | not checked |
| simcoe.fun | — | — | taken |

## The shortlist, with what is wrong with each

**Out in Simcoe** — `outinsimcoe.ca`. Recommended. It is a phrase rather than a label, it
says what the site is for, and it sits well under a sun-over-hills mark. It reads as an
invitation, which is the difference in tone this site is trying to hold against
Civi-Times. Risk: "out" carries other readings, and it does not contain the word "events",
so it earns nothing from search on its own.

**Simcoe Events** — `simcoeevents.ca`. The safe one. Instantly understood, matches what
people type, and pairs with `civi-times.ca` as a plain civic name. Risk: dull, and
generic enough that a municipality could launch something with the same name.

**What's On Simcoe** — `whatsonsimcoe.ca`. Says the job in three words and reads as a
question a person would actually ask. Risk: the apostrophe is lost in the domain, which
looks slightly off to some readers.

**Simcoe Days** — `simcoedays.ca`. Warm and evocative of a day out. Risk: vague on first
contact — it could be a festival, a blog, or a historical society.

**Between the Bays** — `betweenthebays.ca`. The county does sit between Georgian Bay and
Lake Simcoe, so it is accurate and has more character than anything else here. Risk: it
needs a tagline to mean anything, and it will never be guessed or found by search.

## Two things worth deciding alongside the name

**"Simcoe" alone is ambiguous.** There is also a town of Simcoe in Norfolk County, about
200 km south. Any name without "county" in it will collect some of their search traffic
and lose some of ours. Keeping "County" fixes that at the cost of a longer domain.

**Prefer `.ca`.** It signals a local project, it is what the municipal sites use, and it
matches Civi-Times. Buy the matching `.com` only to keep it from someone else.

## What attaching it took (SCEC-33, done)

Two custom domains on the worker (apex and `www`), `CANONICAL_HOST` set to the apex in
`wrangler.jsonc`, then the name itself: the wordmark, `<title>` and share metadata,
`SITE_NAME` in the worker, the manifest, the iCal product id and default calendar name,
and the OG card re-rendered by `brand.ts`.

One thing deliberately did not change: the iCal UID domain. A UID is an identity, not an
address, and rewriting it would make every subscribed calendar delete and re-add every
event.

Old `workers.dev` links keep working, and now answer with the new name and a canonical
link pointing at the domain, so nothing that was shared before the rename is orphaned.
