# Multi-tenant data model

Carried forward from the single-user MVP (`manumaan/instarag`), which is deployed and
working. This is the design that has to be right in the first commit, because retrofitting a
tenant boundary is what makes multi-tenancy expensive.

## The one idea

**Content is global. Membership is private.**

A public reel is the same reel whoever saved it. Fetching it twice, analysing it twice and
storing it twice costs real money — 13.2¢ of Opus 5 per analysis — burns a second request
against Instagram's anonymous rate limit, and buys nothing, because the answer is identical.

So `media` holds content, keyed by the reel itself. A separate `saves` table records who has
it. Two users saving the same reel share one download, one analysis, one set of frames and
one set of index documents. What stays private is *that they saved it*.

This is the highest-leverage decision available: it reduces total fetches rather than
redistributing them, and the effect compounds — the more users, the more overlap, especially
in a niche where the same clips circulate.

## Tables

Changes from the MVP are marked. Everything unmarked is as it is today.

### `media` — global content *(implemented)*
- PK `media_id`
- **Changed:** for a url-sourced post the id is the Instagram **shortcode**, not a uuid, so
  the same link resolves to the same row with no lookup. Uploads keep a uuid; an upload is
  one person's file and there is nothing to deduplicate it against.
- **Removed:** the `byPermalink` GSI. The shortcode *is* the key now.
- **Removed:** the `byCreatedAt` GSI with its constant `entity` partition. Library recency is
  per-user and belongs on `saves`; that constant partition was a documented single-user
  compromise and becomes a hot key the moment there is a second person.
- Holds caption, `analysis_summary`, `places[]`, transcript, status, `s3_key`,
  `cover_s3_key`, `thumb_s3_key`. No `user_id`: status is a property of the content's
  analysis, not of anyone's relationship to it.

### `saves` — who has what *(new, implemented)*
- PK `user_id`, SK `media_id` — answers "does this user have this reel" in one get, which is
  what the save path and every authorisation check need.
- GSI `bySavedAt`: PK `user_id`, SK `saved_at` — the library grid, newest first.
- GSI `byMedia`: PK `media_id` — who to notify when content changes state.
- Per-user fields live here: `saved_at`, and later notes or collections.

### `frames`, `caption_facts`, `transcript_segments`
Unchanged, still keyed by `media_id`. They are derived from content, so they are global too.

### `threads`, `messages` — private
- **Changed:** `threads` PK becomes `user_id`, SK `thread_id`; the constant-partition
  `byCreatedAt` GSI is replaced by sort-key ordering per user.
- `messages` unchanged (PK `thread_id`, SK `created_at`), reached only through a thread the
  caller owns.

### `usage` — what each person has cost *(new)*
- PK `user_id`, SK `usage#YYYY-MM`
- Counters updated with DynamoDB `ADD`, which is atomic and needs no read:
  `downloads`, `bytes_downloaded`, `tokens_in`, `tokens_out`, `analyses`, `plans`, `saves`.
- Written where the numbers already exist: the download handler (`extract/src/metrics.ts`)
  and `lambda/shared/usage.ts`, both of which emit these as CloudWatch metrics today.
- Feeds three later things with no redesign: the per-user quota, the spend cap Phase 7 never
  built, and any billing.
- **Dedupe shows up here as a feature.** Saving a reel someone else already ingested records
  a save and no download and no tokens, because none were spent. Per-user cost falls as the
  shared library grows.

### `invites` *(new)*
- PK `email`, with `invited_by`, `created_at`, `expires_at` (TTL), `accepted_at`.
- Identity stays in Cognito. Admin is a Cognito **group** (`admin`), not a hardcoded address:
  the JWT already carries `cognito:groups`, so the check is on a claim rather than a string
  in the source. `manu.awsian1@gmail.com` is the first member.
- Self-signup stays disabled. An invite creates the Cognito user; the admin screen is a list
  and a form over this table.

### `jobs`, `connections`, the Instagram token table
- `jobs` unchanged.
- **Changed:** `connections` gains `user_id` and a GSI on it.
- **Changed:** the Instagram token table becomes PK `user_id` — it is per-account by nature.
  The KMS CMK encryption carries over unchanged.

## The search index is a security boundary

This is the part to get right.

Index documents are per-moment of *global* content, so one document serves every user who
saved that reel, and nothing in a document says who may see it. Therefore **every query must
be filtered to the media the caller has saved**, enforced server-side from the JWT — never
from a list the client sends.

Mechanically: read the caller's `media_id`s from `saves`, then add
`filter: [{ terms: { media_id: [...] } }]` to both the kNN and BM25 legs in `retrieve.ts`.
Ask, plans and Lens find-similar all go through there, so there is one place to get right
and one place to test.

Rejected alternatives: a `user_ids` array on each document means rewriting documents on every
save, and per-user document copies throw away the dedupe the whole design rests on.

**Known ceiling:** that filter carries the caller's whole save list, so it grows with the
library. Fine at hundreds; wants measuring before thousands — the same
measure-before-you-buy habit that showed the rate limit is not yet a real problem.

## Deleting means unsaving

Not cosmetic, and worth stating plainly: content is shared, so `DELETE /media/{id}` removes
the caller's save and purges the reel only when the last saver lets go. Otherwise the first
person to tidy up would empty a reel out of everyone else's library, taking the 13.2¢
analysis and the downloaded video with it. Nothing is reference-counted — `saves.byMedia` is
asked who is left, which is the same question and cannot drift.

`GET /media/{id}` and retry answer **not found** rather than forbidden for a reel the caller
has not saved. With content shared, "exists" and "yours" are different questions and only
one of them is any of the caller's business.

## S3

- `media/{media_id}/…` unchanged, and deliberately *not* tenant-prefixed: the content is
  shared, which is the point, and it means one 14 MB video rather than one per user.
- **Changed:** `lens/{user_id}/{uuid}` for Lens query screenshots, which are per-person and
  transient. The one-day lifecycle rule carries over.

## Realtime

The MVP broadcaster `Scan`s every open connection and pushes every media change to all of
them. Multi-tenant makes that a leak.

Replace with: media change → `saves.byMedia` for the users who hold it → their connections
via the `user_id` GSI. A user hears about content only when they have saved it.

## What carries over untouched

The pipeline, extraction, the vision pass, the plan builder, Lens, the thumbnailer,
durability and the alarms all operate on content and are unaffected. That is the dividend of
putting the tenant boundary in the data model rather than through the processing code.

## Inherited, and still true

`CLAUDE.md` is copied into this repo and, as in the MVP, kept out of git. It carries the
hard-won facts this build still depends on: the OpenSearch Serverless gaps, the Bedrock
entitlement story and the move to the Anthropic API, ffmpeg's full-range JPEG requirement,
Step Functions refusing to treat a missing Choice path as false, and the measured
rate-limit baseline. Read it before changing anything here.
