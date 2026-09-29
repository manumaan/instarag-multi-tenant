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

### `threads`, `messages` — private *(implemented)*
- **Done:** `threads` is PK `user_id`, SK `id`. Listing someone's threads is a query inside
  their own partition, and there is no key that reaches anyone else's.
- **Done:** the constant-partition `byCreatedAt` GSI — partitioned on the literal `'thread'`,
  so `GET /threads` returned everybody's — is replaced by a **local** secondary index on
  `created_at`: same partition, sorted by time, which is the thing the constant partition
  was faking. An LSI is created with its table and cannot be added later.
- `messages` unchanged (PK `thread_id`, SK `created_at`), reached only through a thread the
  caller owns. It is keyed by thread alone and **cannot tell whose hand is on it**, so
  `requireThread` is the one check standing in front of it, applied by `GET /threads/{id}`
  and by `POST /ask` before a turn is appended. That matters because a thread id is minted
  server-side, handed to the browser and posted back on the next turn — it is the one thing
  about a thread a caller chooses. It answers **404**, not 403: whether someone else's
  thread exists is none of the caller's business.

### `usage` — what each person has cost *(implemented)*
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

### `invites` *(implemented)*
- PK `email`, with `invited_by`, `created_at`, `expires_at` (TTL), `accepted_at`.
- Identity stays in Cognito. Admin is a Cognito **group** (`admin`), not a hardcoded address:
  the JWT already carries `cognito:groups`, so the check is on a claim rather than a string
  in the source. `manu.awsian1@gmail.com` is the first member.
- Self-signup stays disabled. An invite creates the Cognito user, which is what sends the
  email; the invite row records who invited whom, and is deliberately *not* the thing that
  grants access — Cognito is. Status is read from Cognito on each list rather than stored,
  so a row cannot go stale claiming "pending" after someone has signed in.
- **Withdrawing only works on an unaccepted invite.** Someone who has signed in has a
  library, threads and a usage history; deleting their account from a screen called
  "invites" would be a destructive act wearing an administrative label. Removing a member is
  a different operation and should look like one.
- The admin screen shows the `usage` ledger beside the invite list, since "who is here" and
  "what have they cost" are the same question asked twice.

### `jobs`, `connections`, the Instagram token table
- `jobs` unchanged.
- **Done:** `connections` gains `user_id` and a GSI on it (`byUser`), which is what lets the
  broadcaster push to the people holding a reel instead of scanning every socket.
- **Done:** the Instagram token table is PK `user_id`, SK `kind` — per-account by nature.
  The KMS CMK encryption carries over unchanged.
  - `kind: 'connection'` is the token row; `kind: 'state#<state>'` is an in-flight OAuth
    state, TTL'd, in the partition of whoever began the flow. **The user is in the key, not
    in a field**, so a state handed to another account is not merely rejected — it is not
    there to find, and there is no check to forget.
  - Every connect handler now resolves a caller. Three of them (`start`, `status`,
    `disconnect`) previously took no event at all, because there was only ever one account.
  - The daily refresh has no caller, so it is the one place that reads across users:
    `allConnections()` sweeps every token row (a filtered Scan — one row per connected
    person, swept once a day) and renews each inside its window. It renews serially and
    catches per account, because a token Meta refuses to refresh is exactly the token about
    to lapse, and stopping there would take everyone after it down with it.
  - Sync keys what it ingests by **shortcode**, exactly as a pasted link does, so one post
    is one row whichever route it arrived by. A post already held — by this account or by
    anyone — is *saved* rather than fetched again; ingesting it afresh would mean two
    downloads and two of everything downstream. A permalink that will not parse falls back
    to a uuid, and for those the `ig_media_id` of the caller's own saves is what recognises
    the post on a later sync.

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
- **Done:** `lens/{user_id}/{uuid}` for Lens query screenshots, which are per-person and
  transient. The one-day lifecycle rule carries over unchanged, since it matches `lens/`.
  The key travels in the request body, so the prefix is what makes a borrowed one useless:
  `requireOwnLensKey` refuses a key outside the caller's own partition before the object is
  read.
- Searching **from a frame** needs the reel saved, on `/lens/web` as well as `/lens/similar`.
  `/lens/web` had no caller at all: it would read any frame given `{mediaId, tsMs}` and then
  describe it, and its two model calls were charged to nobody.

## Realtime *(implemented)*

The MVP broadcaster `Scan`ned every open connection and pushed every media change to all of
them — one person's reel arriving in someone else's browser with its caption and analysis
attached.

Now: media change → `saves.byMedia` for the users who hold it → their sockets via
`connections.byUser`. A socket's identity is established once, at `$connect`, from the
authorizer's verified claim; a connection with no identity is refused rather than stored,
because an unattributed socket cannot be filtered later and filtering is the whole job.

`dynamodb:Scan` was also removed from the broadcaster's policy. The old behaviour is now
unrepresentable rather than merely unwritten, and a test asserts the grant stays gone.

## Deploying beside the MVP

Most of a CDK stack's physical names are scoped to the stack, so a copied repo deploys
alongside its original without anyone thinking about it. Four names are not, and all four
arrived here as constants:

- **The stack id.** `ReelLens` in account 250037328911 is not a second stack — it is an
  update to the live single-user one, whose tables are RETAIN and whose media bucket is
  versioned. It is `ReelLensMultiTenant` now (`-c stackName=`).
- **The Cognito hosted-UI domain prefix** is unique across the whole region, so
  `reel-lens-<account>` fails outright on a second stack. Derived from the stack name.
- **A Secrets Manager name** is unique per account, so `instarag-claude-key` cannot be
  created twice. It is `-c claudeSecretName=`, defaulting to `instarag-claude-key-mt` — its
  own key, which also keeps the two deployments' spend separable on Anthropic's side.
- **The OpenSearch collection**, and the encryption, network and data-access policy names
  derived from it. `reel-lens-<account>` is unique per account and region, so a same-account
  deploy fails on "already exists" — it would not have pooled the two libraries' frames, but
  it would not have deployed either. Derived from the stack name, with the account dropped
  (these names are account-scoped already) so the `-grp`/`-enc`/`-net`/`-data` suffixes fit
  inside the 32-character cap.

**The container image is a non-issue, and deliberately so.** All three pipeline handlers come
from one `DockerImageAsset`, which CDK pushes to the *bootstrap* repo
(`cdk-hnb659fds-container-assets-<account>-<region>`) under a tag that is the hash of the
build context. Two stacks share that repo by design; identical content means one image and
no duplicate push, and different content means a different tag. This repo's `extract/`
differs (it adds `src/ledger.ts` and changes `download.ts`), so it gets its own tag. The one
thing to watch was the **ECR lifecycle policy** on that account, which counts across every
stack pushing into the repo: at keep-three, two stacks deploying in turn could expire an
image the other still references. **Raised to five on 2026-09-29**, previewed first —
`start-lifecycle-policy-preview` reported `expiringImageTotalCount: 0`, since only three
images remain.

**The account is the MVP's** (250037328911, us-east-1), decided 2026-09-29. The two stacks
share a bill, the CDK bootstrap and that image repo; nothing else, now that the four
account-scoped names above are derived from the stack name. `cdk ls` answers
`ReelLensMultiTenant`, and the live stack is `ReelLens`.

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
