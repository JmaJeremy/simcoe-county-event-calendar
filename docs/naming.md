# Names and domains

The site ships under the placeholder **Simcoe County Events** on `scec-web.thejeremy-net.workers.dev`.
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

## When one is chosen

SCEC-33 covers attaching it: register, add a Cloudflare custom domain to the `scec-web`
Worker, set the `CANONICAL_HOST` var so the `www` host redirects, then update the wordmark,
`SITE_NAME`, the manifest and the OG card, and re-run `brand.ts`. Short links already use
whichever origin served them, so old `workers.dev` links keep working.
