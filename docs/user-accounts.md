# User accounts and personal calendars

A design for letting a reader keep their own calendar on Out in Simcoe: sign in, pin
events, subscribe to standing criteria, take the result away as an `.ics` feed, optionally
publish it at a shareable link, and optionally get it by email once a day or once a week.

Nothing here is built yet. This document exists so the hard decisions — password hashing
inside a Worker's CPU budget, where an OAuth `state` lives when there is no KV, what
happens to a pin when de-duplication retires the event under it — are argued once, in
writing, rather than five times in a pull request.

## What this buys, and what it does not

It is worth being honest at the top: the site already has a personal calendar feature.
`/calendar.ics?m=tay&cat=music` is a filtered, subscribable feed, it needs no account, and
it works today. Anyone who wants "music in Tay, in my phone's calendar" is already served.

Accounts buy four things that URL cannot:

- **Pinning one event.** A filter selects a class of events. There is no way to say "this
  fair, and that concert, and nothing else like them".
- **The same list on every device**, without copying a URL between them.
- **A calendar you can hand to someone else**, as a page rather than a query string.
- **Digests**, which push rather than pull, and reach people who will never subscribe to a
  feed in a calendar app because they have never subscribed to a feed in a calendar app.

Against that: this is the largest feature in the repository — larger than the console — and
it creates the site's first real store of personal information. A site that currently holds
one day-salted IP hash and whatever a visitor typed into the suggestion form would begin
holding email addresses, password hashes and session tokens. That is a different kind of
thing to operate, and the rest of this document is mostly about operating it safely.

## Two databases

**Account data lives in its own D1 database, `scec-accounts`. The existing `scec` database
keeps listings, events, sources, suggestions and run logs, and gains nothing.** The web
worker binds both — `DB` and a new `ACCOUNTS`. The ingest worker binds only `DB`, exactly as
it does now.

The reason is blast radius. The ingest worker parses hostile HTML from 39 third-party sites
and ships listing text to a language model. A separate database means that a parser bug, an
injection through scraped content, or a mistake in the de-duplication judge cannot reach a
password hash, because the binding is not there to reach it with. It also means a copy of
the public database — the one that gets pulled onto a laptop to run `dedup-report.ts` —
contains no personal data at all. Both are much stronger guarantees than table-level care in
a shared database, and both are cheap now and expensive to retrofit.

What it costs, stated plainly:

**There are no cross-database joins.** D1 cannot join `calendar_pins` to `events`. Every
read that needs both does two queries and joins in the worker: pinned ids out of `ACCOUNTS`,
then `SELECT … FROM events WHERE id IN (…)` against `DB`. That `IN` list must be chunked
against D1's bound-parameter limit rather than assumed to fit — a reader with two hundred
pins is not unreasonable, and the failure mode if it is not chunked is a query that works
in testing and throws for the site's most engaged user.

**There are no cross-database transactions.** `batch()` is per-database. This turns out not
to bite, because no write ever spans both: accounts never write to `events`, and the
pipeline never writes to accounts. The separation is clean in the write direction, which is
the only reason it is workable at all.

**Saved criteria are unaffected.** A saved filter is a query string; it lives in
`scec-accounts` and runs against `scec`, with nothing to join. See below.

**Local development, CI and the deploy runbook each grow a second migration step.** The
command block in `CLAUDE.md` and `AGENTS.md` needs the second `d1 migrations apply` line,
and `.github/workflows/deploy.yml` must migrate both databases before it deploys either
worker.

### This moves the digest sender to the web worker

The obvious home for a scheduled job is the ingest worker, because it owns the only cron
trigger. Under segregation that is exactly backwards: it would hand the scraper a write
binding to the account database and undo the point of the split.

So **digests are sent by the web worker**, which already needs both bindings. A Worker can
carry a `scheduled()` handler alongside its `fetch`, so this is a `triggers.crons` entry in
`apps/web/wrangler.jsonc` and a new handler. It has a second benefit: the ingest worker's
`scheduled()` currently ignores its `event` argument because there is one cron doing one
job, and adding digests there would have forced `event.cron` dispatch into existence. On the
web worker there is again one cron doing one job, and no dispatch is needed.

A third worker, `scec-digest`, would give the same isolation with more moving parts to
deploy, secret and monitor. Rejected.

## Identity and sign-in

Two ways in: an email and password, or Google. Apple and Facebook are deliberately out of
scope — Apple requires a paid developer account and a client secret that expires every six
months, and Facebook requires business verification and app review before it will release an
email address. Both are a seam rather than a rewrite once the `user_identities` table below
exists, and neither is worth blocking on.

### Passwords

PBKDF2-HMAC-SHA256 through `crypto.subtle.deriveBits`. This is not a preference; bcrypt,
scrypt and Argon2 do not exist in workerd without shipping WebAssembly, and PBKDF2 is what
the platform gives.

```ts
const bits = await crypto.subtle.deriveBits(
  { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
  await crypto.subtle.importKey('raw', peppered, 'PBKDF2', false, ['deriveBits']),
  256,
)
```

Stored as `pbkdf2$sha256$<iterations>$<salt>$<hash>`, salt sixteen bytes from
`crypto.getRandomValues` — which appears nowhere in the repository today; `randomUUID` is
the only randomness currently used, and it is not the right tool for a secret. The encoded
iteration count is what lets the number rise later without invalidating every stored hash:
verify with the iterations the record names, and re-hash on a successful sign-in if they are
below the current floor.

**PBKDF2 alone is weak at the iteration counts a Worker's CPU budget allows**, and pretending
otherwise would be the most dangerous sentence in this document. The fix is a **pepper**: a
Worker secret, `PASSWORD_PEPPER`, HMAC'd over the password before it reaches PBKDF2. It is
not stored in either database, so an attacker holding a full dump of `scec-accounts` has
nothing to grind against. The pepper carries the strength the iterations cannot, and the
iteration count is then tuned to whatever fits comfortably inside the request budget rather
than to an offline-attack threat model it was never going to meet. Measure the real cost on
the deployed plan before fixing the number; state it in a comment next to the constant.

Constant-time comparison is new code — nothing in the repository compares secrets today, and
`/run`'s token check is a plain `!==`. `packages/adapters/src/sigv4.ts` is the model for
Web Crypto in this codebase.

**Email verification is mandatory before a password account can be used.** This is not
hygiene, it is the thing that closes an account-takeover path. Without it, an attacker
registers a password account on a victim's Gmail address and waits; when the victim later
signs in with Google and the two are linked on matching address, the attacker's password
opens the victim's account. Requiring a verified address before the account does anything
means there is no unverified account sitting there to be linked to.

Minimum rules: a length floor and nothing else. Composition rules push people toward
`Passw0rd!` and the pepper is doing the real work.

### Google

Authorization Code flow with PKCE.

The interesting problem is that `state`, `nonce` and the PKCE `code_verifier` have to
survive a round trip to Google, and there is no KV in this stack. Writing them to
`scec-accounts` works but means a database write for every sign-in *attempt* — including
every bot that discovers the route — plus a cleanup job for the ones that never come back.
Instead they travel in **a short-lived HMAC-signed `HttpOnly` cookie**. No write, no
cleanup, no table to fill, and the values are naturally bound to the browser that started
the flow, which is the property `state` exists to provide in the first place.

On the callback: verify the `id_token` with `jose` against Google's JWKS, with the issuer
and audience pinned and `algorithms: ['RS256']`, check the `nonce` against the cookie, and
require `email_verified === true`. An unverified Google address is not proof of anything.

`jose` is already a dependency of `@scec/ingest` for Access verification, and
`apps/ingest/src/access.ts` is the pattern to copy — including the injectable key-set
parameter that exists purely so tests can sign with a local key pair. **It must be added to
`@scec/web`'s dependencies**, where it is not currently present.

### Abuse

Sign-in and password-reset are rate limited on the pattern `handleSuggestion` already uses:
a day-salted `sha256` of `CF-Connecting-IP` and a `COUNT(*)` over recent rows, here in an
`auth_attempts` table in `scec-accounts`. Limited per IP *and* per account — per-IP alone
does nothing against a distributed attempt on one address, and per-account alone lets one
host walk a list. The suggestion form's own limiter stays where it is, in `scec`.

Turnstile guards sign-up and password-reset, the two routes where abuse is free. **Sign-in
deliberately does not use Turnstile**, so that signing in works with JavaScript off; the
rate limiter covers credential stuffing, and a sign-in page that fails closed without
JavaScript is a worse trade than the suggestion form's, because a suggestion is a one-time
act and signing in is how someone reaches everything they own.

## Sessions

An opaque token of 256 bits, stored as its SHA-256 hash in `user_sessions` — not a
stateless signed cookie. Revocation and "sign out everywhere" have to actually work, and a
stateless token cannot be withdrawn before it expires. The extra read per request is one
indexed lookup in a small table.

The cookie is `HttpOnly; Secure; SameSite=Lax; Path=/`, with a rolling expiry and an
absolute cap so an unattended session cannot live forever. `SameSite=Lax` plus the existing
`isSameOriginWrite()` from `apps/ingest/src/access.ts` is the CSRF defence — the same
header-based pair the console relies on, with no CSRF tokens to mint or verify.

One host detail: the site answers on the apex, on `www` (301 to the apex), and on the
workers.dev fallback. A cookie set on the fallback is a different cookie jar, so account
routes **302 to `CANONICAL_HOST`** when reached anywhere else. One place to be signed in.

## Schema and migrations

The new database gets its own migrations directory, `apps/web/migrations/`, starting at
`0001_accounts.sql`. This breaks the repository's current rule that every migration lives in
`apps/ingest/migrations/` — a rule that exists because there has only ever been one
database. `apps/ingest/migrations/` continues to own `scec` and is untouched by this work.

House style throughout: a prose comment at the top saying why the table exists, TEXT ids,
ISO-8601 TEXT timestamps, INTEGER booleans, JSON in TEXT.

| Table | What it holds |
|---|---|
| `users` | Identity only: id, lowercased email (unique), verification time, display name, timestamps |
| `user_passwords` | One row per password account: the encoded PBKDF2 string, when it was last changed |
| `user_identities` | One row per external identity: provider, subject, linked-at. Unique on (provider, subject) |
| `user_sessions` | Hashed session token, user, created, last-seen, absolute expiry |
| `user_tokens` | Email verification and password reset, one table with a `purpose` column, single-use, short TTL |
| `calendar_pins` | User, event id, pinned-at, plus a title/date snapshot (see below) |
| `calendar_filters` | User, label, and the saved query string |
| `user_calendars` | One row per user: hashed feed token, public slug, whether public, digest cadence and local send hour, timezone |
| `digest_sends` | (user, period key) with the outcome — the idempotency record |
| `auth_attempts` | Day-salted IP hash, account key, timestamp — the rate limiter |

Indexes are justified one by one against the query that needs them, with particular
attention to the reads that exist only because the join happens in the worker rather than in
SQLite.

## Saved criteria are a query string

This is the piece of the design that costs almost nothing, so it is worth saying why.

The site's filter language already exists, and it is the URL. `parseFilters()` reads it,
`listUrlFrom()` canonicalises it against a whitelist — deliberately rebuilding rather than
echoing, because the input is a stranger's text — and `buildQuery()` turns it into bound
SQL. All three live in `apps/web/src/query.ts` and all three are already tested.

So a saved subscription is **one column holding a canonical query string**. "Subscribe to
this" is literally "save this view". There is no second filter schema to keep in step with
the first, no new validation, no migration when a filter is added, and the stored value is
something a person can read and a developer can paste into the address bar. It also crosses
the database boundary without a join: the string lives in `scec-accounts`, the query runs
against `scec`.

## Tags

**Recommendation: do not add a tag facet. Add a keyword filter instead.**

There are no tags in the data model. The nearest thing is `Listing.sourceCategories`, the
raw label text each source applies to its own events — and `classifyCategory` exists
precisely to extract signal from that text and throw the rest away. It skips labels that say
nothing ("Events", "Orillia events") and department names ("Recreation, Parks, and
Facilities events") because reading them literally put 227 yoga, beading and chess sessions
outdoors. Surfacing that same text to readers as tags would hand them the labels the
category rules were written to ignore.

A real tag facet is a project: a controlled vocabulary, a mapping per source for fifteen
adapters, a new column on `events`, and a decision about how de-duplication merges tag sets
across a cluster whose listings disagree. It should have its own ticket and its own
measurement, not a paragraph in this one.

What people usually mean by "tag me into this" is a keyword: *anything with "pickleball" in
it*. That is a small, honest addition — a `q` parameter on `EventFilters` matching the
title — and because subscriptions are query strings it becomes subscribable for free.

## The private feed

A calendar application cannot send a cookie, so the feed must carry its own capability:
`/calendar/{token}.ics`, 256 bits, stored hashed in `user_calendars`, rotatable from the
account page. It answers with `Cache-Control: private, no-store` and
`X-Robots-Tag: noindex, nofollow`.

Assembly reuses everything: the token resolves against `ACCOUNTS`, the pinned ids and saved
query strings turn into two reads against `DB` through `buildQuery`, and the result goes to
`buildIcal` unchanged.

**The union must be de-duplicated by event id before `buildIcal` is called.** A pinned event
that also matches a saved filter arrives twice, and every entry's UID is
`${event.id}@outinsimcoe.ca` — two `VEVENT`s with one UID in one feed is undefined behaviour
that different clients resolve differently, all of them badly. De-duplicate on the way in.

The UID domain does not change. That is settled elsewhere and is repeated here only so that
nobody reaches for a per-user namespace to solve the collision above: a user's feed and the
public feed must agree on an event's UID, or a reader subscribed to both gets two copies of
everything.

### Pins outlive their events, sometimes

On govStack, Drupal rows and SPACES the listing id encodes the date, so an organiser moving
an event retires one listing and creates another. De-duplication then builds a **new cluster
with a new id and a new short code**, and closes the old event. A pin is a foreign key into
a table in another database with no referential integrity and a documented habit of
retiring rows.

So `calendar_pins` keeps a snapshot of the title and start date at the moment of pinning.
When the event id no longer resolves, the account page says the listing was withdrawn and
names what it was, and the feed drops it. A blank row, or a feed entry that silently
vanishes, is how a reader loses trust in the whole calendar.

## Sharing a calendar

A public calendar is a **separate slug and a separate token** from the private feed. This is
the single most important line in the section: if publishing exposed the private feed token,
sharing a calendar would hand over the ability to change it.

`/c/{slug}` renders the calendar as a page; `/c/{slug}.ics` is its feed. Both are `noindex`
by default, because privacy-first means a shared calendar is for the people you send it to,
not for search engines. The slug is generated, not chosen — a vanity slug invites both
squatting and impersonation, and can be added later if anyone asks.

Turning sharing off and on again mints a new slug, and the old link dies. That is the safe
default: "I want this link to stop working" is the reason people turn sharing off, and it
would be a poor surprise to find the old link live again a week later. A "keep the previous
link" option is possible and should be an explicit choice, not the default.

## Digests

The web worker gains a cron, for the reason in the two-databases section.

**Schedule hourly** — `5 * * * *` — and send to the users whose configured local hour
matches the current hour in America/Toronto. A fixed UTC schedule would drift by an hour
across daylight saving, twice a year, and would force every reader onto the same send time.
Most runs will find nobody and do nothing.

### Two ceilings, not one

Each message is a subrequest, and the digest cron is its own invocation on its own worker,
so it never shares the ingest run's ~660 of the 1,000-subrequest budget.

The other ceiling is the binding's: **1,000 messages a day, account-wide**. That is
comfortable at current volume, but the suggestion thank-you and the acceptance email draw on
the same allowance. So the design carries a per-run cap *and* a daily budget checked against
`digest_sends`, with headroom reserved for transactional mail. A digest surge must never be
able to silently eat the reply a visitor gets for suggesting an event — the visitor has no
idea a digest exists, and would simply conclude the form is broken.

Anything over the cap waits for the next hourly run. This is the repository's existing idiom
for work that does not fit in one invocation: a table drained a few rows at a time with the
outcome recorded, as `enrich.ts` does for detail pages and `cost_decisions` for prices. Not
Queues, which this stack does not use anywhere.

### Sending once, and only when there is something to send

`digest_sends` is keyed on the user and a period key — `d:2026-09-20`, `w:2026-W38` — so a
re-run, an overlapping invocation or a retry cannot produce a second copy. A window with no
events records `skipped-empty` rather than mailing a cheerful message about nothing.

The body is plain text, assembled from database values. It contains no address literal, so
`no-email.test.ts` is unaffected by it.

### Unsubscribe, and the suppression list

Every digest carries a capability-token link. Following it does two things, in this order:

1. **Sets the user's digest cadence to none** in `scec-accounts`. Authoritative, instant,
   reversible from the account page.
2. **Adds the address to the Cloudflare account's suppression list** through the Cloudflare
   API. This is the safety valve, and its whole point is that it sits *below* our own code:
   it keeps working if step 1 failed, or if a future change reintroduces the address.

The order matters. The local stop is immediate and cannot fail; the network call is second
so that the reader's unsubscribe is never waiting on Cloudflare to answer.

Four consequences, each of which will otherwise be discovered the hard way:

- **The suppression list is account-wide, so it also blocks transactional mail.** Somebody
  who unsubscribes from digests and later suggests an event will not receive their
  thank-you. That is the honest price of a valve beneath our own code, and it is still the
  right default — but the account page must show suppression state and lift the entry when
  the reader re-subscribes. A block nobody can see is a block nobody can undo.
- **It needs a Cloudflare API token on the web worker**, scoped to the narrowest Email
  Sending permission that will do. This is a new class of secret: the deploy token lives in
  GitHub Actions and has never been inside a Worker. Worth naming rather than slipping in
  beside the others.
- **The call can fail.** Its outcome is recorded on the row and retried on a later run —
  the same never-throw, record-the-fate pattern `suggestions.admin_mail` already uses.
  Unsubscribing must never return an error because Cloudflare was unreachable.
- **A GET that changes state gets prefetched** by mail scanners and link previewers. Both
  effects here run in the conservative direction — the worst a stray prefetch does is stop
  mail that the reader can turn back on by signing in — so one-click is kept rather than put
  behind a confirmation button. This is a judgement call, and the suppression coupling makes
  it a closer one than usual; it is recorded here as a decision, not an oversight.

The exact endpoint and token permission are to be confirmed against current Cloudflare
documentation when this is built. Nothing in the design depends on their shape.

**`List-Unsubscribe`.** The `SendEmail` interface in this repository is hand-written and
covers only `{to, from, replyTo, subject, text}`, which describes what the workers use — not
necessarily what the binding accepts. Check before assuming. If headers can be set,
`List-Unsubscribe` and `List-Unsubscribe-Post` should point at the endpoint above, now that
a one-click handler exists to receive them. If they cannot, the in-body link is the fallback
and the cost is the absence of the unsubscribe button Gmail renders beside the sender.

## The front end

Account pages are **server-rendered**, in a new `apps/web/src/account.ts`, following the
console's shape: plain forms, POST, 303 on success, `Cache-Control: no-store`, a CSP pinning
`form-action 'self'`, and `noindex`.

A static `public/account.html` does not work. The assets binding sets
`run_worker_first: ["/", "/index.html"]`, so every other file under `public/` is served
straight from the edge without the worker seeing it — there would be nothing to gate it
with.

### Not breaking the cache

`/api/events` stays public and edge-cached, exactly as it is. Nothing per-user is added to
it.

Sign-in state comes from a new `GET /api/me`, served by a new `privateJson()` helper:
`Cache-Control: private, no-store`, and **no `Access-Control-Allow-Origin`**. The existing
`json()` helper sets `public, s-maxage=…` alongside a wildcard CORS header, which is correct
for a public event list and catastrophic for a per-user response — it would place one
reader's data in a shared cache behind a header inviting any origin to read it. The two
helpers must be visibly different at the call site, and this is the one thing in this
document most likely to be got wrong by someone reaching for the nearest existing function.

Pin buttons render inert for everyone and are activated by a small client module from
`/api/me`. That keeps `/e/{code}` byte-identical for anonymous and signed-in readers alike,
so it stays cacheable and the anonymous path is untouched.

## Privacy, deletion, and the no-email test

**Hard delete, no tombstone.** Segregation makes this genuinely clean: everything about a
person is in one database, so deletion is a bounded set of statements in a single `batch()`
with nothing stranded in `scec`. Sessions, tokens, pins, filters, calendar and digest rows
all go, and the public slug is freed. Retaining a hashed email to throttle re-registration
would mean keeping personal data about someone who asked to be forgotten, to defend against
an abuse case the rate limiter already covers.

A suppression entry is the one thing that should survive deletion, since its purpose is to
stop mail reaching an address that no longer has an account to hold the preference.

**On `no-email.test.ts`:** a reader's own address, rendered from the database at request
time, is not in any source file, so the test passes untouched. But the test scans only the
top level of `apps/web/public/` and the `reply(` lines of `apps/web/src/worker.ts` — a new
`account.ts` would not be covered at all. **Widen the scan to `apps/web/src/*.ts`** so the
guard grows with the surface instead of quietly failing to cover the newest code. That is a
change to make while adding the feature, not afterwards.

## Testing

Three patterns already exist in `apps/web/test/`, and each new area maps onto one:

| Area | Pattern |
|---|---|
| Hash and verify, constant-time compare, the `q` filter | Pure unit, like `query.test.ts` |
| Routes, cache headers, CSRF refusal, noindex | `stubEnv` SQL dispatch, like `seo.test.ts` |
| Sessions, pins, digest idempotency | Stateful harness, like `poster.test.ts` |
| Google `id_token` verification | Local JWKS, like `apps/ingest/test/access.test.ts` |

Two things to get right in the fixtures. **The stubs need two databases**, and a test that
accidentally answers an accounts query from the events stub would hide exactly the class of
bug segregation exists to prevent — so the helper should refuse an unrecognised query rather
than fall through to a default row. And Google verification is tested with a locally
generated key pair, because `npm test` is promised to run with no network.

## Operations

- Create `scec-accounts`; add the `ACCOUNTS` binding and `migrations_dir` to
  `apps/web/wrangler.jsonc`.
- Add `jose` to `@scec/web`.
- Add the cron trigger to `apps/web/wrangler.jsonc`.
- New secrets on the web worker: `PASSWORD_PEPPER`, the OAuth state signing key,
  `GOOGLE_CLIENT_SECRET`, and the scoped Cloudflare API token for suppression. The Google
  client id is public and can be a plain var. Add them all to `.env.example` with a comment
  saying what each is for, as the existing entries do.
- Google Cloud: an OAuth client with the callback on the apex, and on localhost for
  development.
- `.github/workflows/deploy.yml`: migrate **both** databases before deploying either
  worker. The suggestion form's history is the precedent — deploying a worker ahead of its
  migration means a 500 on the first request that touches the new table.

**Fail-closed rules differ by dependency, on purpose.** Without the pepper or the Google
secret, the auth routes answer 503 and the Google button is not rendered — the posture
Turnstile and Access already take. But without the suppression token, unsubscribe still
succeeds locally and records that the suppression entry is owed. Failing closed on sign-in
protects the reader; failing closed on unsubscribe traps them.

## A build order

The design is complete rather than phased, but the work still lands in an order, and each
step below leaves the site deployable:

1. `scec-accounts`, the migration, the bindings, the two-database test fixtures.
2. Sessions and password sign-up, sign-in, verification and reset. Nothing personal to show
   yet — the win is that the security-critical half lands on its own and gets reviewed on
   its own.
3. Google.
4. Pins and saved filters, the account page, `/api/me`, the pin control.
5. The private feed.
6. Public sharing.
7. Digests, unsubscribe and suppression.

## Risks, ranked

1. **The PBKDF2 CPU budget.** Measure on the deployed plan before fixing the iteration
   count. If it does not fit, the pepper is what makes a lower count survivable — but that
   is a reason to be deliberate, not a reason to skip the measurement.
2. **The account-wide suppression list blocking transactional mail.** Foreseeable, and a
   support burden if the account page does not surface it plainly.
3. **The runtime Cloudflare API token.** A new class of credential in a worker. Scope it
   tightly and note it in the deployment section of `CLAUDE.md`.
4. **The 1,000-a-day allowance**, shared between digests and the mail a visitor is actually
   waiting for.
5. **The application-side join.** It is the place a future contributor will reach for a JOIN
   that does not exist, and the error will not be obvious. It belongs in the "things that
   will bite you" list.
6. **Pins pointing at retired event ids**, handled by the snapshot above, but only as well as
   the snapshot is kept current.

## Documentation to update when this is built

`CLAUDE.md` and `AGENTS.md` carry the same command block and the same "things that will bite
you" list. Both need the second database, the second migration step, the two-worker cron
split, the `json()` versus `privateJson()` distinction, and the no-cross-database-join rule.
Change one, change both.

## Ticket

This work has no SCEC key yet; `docs/jira-keys.json` should gain one — and probably several,
one per step of the build order — before implementation starts.
