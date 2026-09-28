# Reel Lens

Instagram reel & post analysis with Claude.

**Built so far: Phases 1-6, plus public reel downloading and carousels.** Upload a screen
recording, a carousel's slides, or screenshots, or paste any public reel permalink. A pasted permalink is downloaded with
yt-dlp; everything then runs through keyframe extraction on ingest, with progress pushed
to the browser over a WebSocket, and lands on the reel detail screen as a filmstrip.
Each reel then gets a Claude vision pass that writes per-frame descriptions, verbatim OCR,
and the places it can actually read off the signage, then gets embedded into a vector
index so you can ask questions about it, or find it again from a screenshot.

Downloading public reels is unauthenticated: no IG account, no password, no cookies. It
does violate Meta's ToS, and Instagram rate-limits anonymous access — a burst of ingests
from one IP range will start returning "you have exceeded the rate-limit for accessing
posts anonymously", which clears with time. Connected mode does not help there: it reaches
your own media only. A screen recording always works.

Pasting a reel already in the library returns the existing item rather than downloading it
again, so repeats cost nothing against that limit. A failed attempt is still retried, which
is what makes re-pasting after a rate limit clears the right move. The
exposure is the fetching IP being blocked rather than an account ban, since no account is
involved; yt-dlp is pinned in `infra/extract/Dockerfile`, and bumping that version is the
expected fix when Instagram changes its markup and downloads start failing.

## Layout

```
infra/           AWS CDK app (TypeScript) — storage, auth, API, pipeline, index, hosting
infra/extract/   Keyframe extraction Lambda: container image with static ffmpeg
web/             Next.js app — Library and Reel detail screens
scripts/         write-web-env.sh (env from stack outputs) + two end-to-end test scripts
```

## Ingest pipeline

Completing an upload starts a Step Functions execution, which owns every status the
record takes on:

```
queued -> [downloading ->] extracting -> analysing -> [transcribing ->] indexing -> ready
                                                                                 \-> failed
```

The `downloading` leg runs only for a pasted permalink; an upload is already in S3. The
download also yields the reel's caption, uploader and posted-at date from its public
metadata, so a URL-sourced reel gets a caption without an OCR pass.

A carousel joins at `analysing`: its slides are already images, so there is nothing to
extract from and no audio to transcribe. A pasted link still downloads first, because what
a permalink points at is only known once its metadata has been read — so the reel/slides
branch sits after the download, not before it.

## Carousels

Drop several images at once and they become one carousel post rather than several reels;
videos stay individual. Up to 20 slides. **Pasting a carousel or image-post link works the
same way** — the slides are fetched from the link, at full resolution, with the caption.

A carousel is a set of slides, not a timeline, so the upload puts each slide straight into
the reel's `frames/` prefix and writes a frame row for it. Slides are numbered through
`ts_ms` — slide 1 is 0ms, slide 2 is 1000ms — which means citations, Lens and the vector
index needed no changes at all: a citable moment is still `{media_id, ts_ms}`. The UI shows
"slide 3" where a reel would show "0:12", so the timestamps stay behind the scenes.

The vision pass is told it is looking at slides and asked what the post as a whole is
saying, since a carousel is usually one argument told across slides — a list, a recipe, a
before-and-after — rather than a sequence of moments.

Slides fetched from a link are re-encoded to 1568px on the long edge rather than the 720px
keyframes get: a slide is read, not skimmed, and 1568 is the point beyond which Claude's
vision downsizes an image anyway. On a real 11-slide post every slide's text came back
verbatim, and asking "what does it say to book first?" answered from slide 8.

A video card inside a mixed carousel is skipped, and the slide numbering keeps its place —
slide 3 is still the third card of the post. Analysing it would mean running the whole reel
pipeline for one slide.

## Speech

Extraction also pulls a mono 16 kHz audio track, and reels that have one go through Amazon
Transcribe with automatic language identification. The transcript is stored as segments,
split at sentence boundaries so each one is a useful citation target, and indexed alongside
the frames — so Ask can answer a question whose evidence was only ever spoken, and cite the
second it was said. A reel with no audio skips this leg; a transcription that fails leaves
the reel usable rather than failing it.

Two things to know about the output. ASR mishears proper nouns — the caption's
`@no_diet_club` came back as "No Doubt Club" — so the caption and frame OCR are the
authority on names, and speech is the authority on what was said. And Transcribe returns
coarse blocks (a 46s reel came back as three ~20s segments), so segments longer than ~10s
are split with timestamps apportioned by character count: close enough to put the player
within a second or two, not exact.

## Connected mode

Links your own Instagram Business or Creator account through Meta OAuth, and pulls your own
reels in through the same pipeline everything else uses. **No Instagram password, cookie or
session is involved** — and it only reaches your own media, so it is not a way to fetch
other people's reels.

Setting it up needs a Meta app, which only you can create:

1. At developers.facebook.com, create an app and add the **Instagram** product with
   *Instagram API with Instagram Login*.
2. Your Instagram account must be **Business or Creator** — personal accounts cannot connect.
3. Add this exact redirect URI to the app (it is a stack output, `ConnectedRedirectUri`):
   `https://<your-cloudfront-domain>/connect/callback/`
4. Deploy with the app id, then put the app secret into the secret the stack created:

```bash
cd infra && npm run deploy -- -c instagramAppId=YOUR_APP_ID
aws secretsmanager put-secret-value \
  --secret-id "$(aws cloudformation describe-stacks --stack-name ReelLens \
    --query "Stacks[0].Outputs[?contains(OutputKey,'AppSecretArn')].OutputValue" --output text)" \
  --secret-string 'YOUR_APP_SECRET'
```

The `/connect` screens were removed on request, so there is currently no button for this —
the endpoints are still deployed and can be driven directly, and restoring the UI means
re-adding `web/app/connect/`.

The long-lived token lasts 60 days, is stored encrypted under a customer-managed KMS key,
and is refreshed daily by a scheduled Lambda once it is old enough to be refreshed — letting
it lapse would mean re-authorising by hand.

## Retrying

A failed reel gets a Retry button, on its library tile and its detail screen. Failures here
are often temporary: Instagram's anonymous rate limit clears on its own, and a codec the
extractor choked on may be fixed by the next deploy.

Retry is a real re-run. Anything a half-finished pipeline left behind — frames, transcript
segments, caption facts, index documents — is cleared first, so one run's output cannot mix
with another's. A pasted permalink is fetched again; an uploaded file keeps its original,
since there is no other copy of it.

A carousel keeps its slides and its cover thumbnail. Its slides are its source material
rather than something the pipeline derived, so a retry clears only the descriptions and OCR
written onto them and then re-analyses the same images.

## Speed

Measured on a 46s reel with 20 frames: about a minute end to end, of which the vision call
is 45-53s. Two things were worth fixing:

- **Indexing went from 35s to 2s.** It was 25 embeddings awaited one at a time, each an S3
  read plus a Bedrock call and almost entirely network wait. `EMBED_CONCURRENCY` (default 8)
  bounds the fan-out so a long reel cannot trigger throttling.
- **Transcription is now free.** It runs beside the vision call in a Step Functions Parallel
  branch — the two read the same reel, write different fields and need nothing from each
  other — so the Transcribe poll hides behind analysis instead of adding to it.

What is left is the vision call itself, and the only levers there trade quality for speed:
`ANALYSIS_EFFORT` (medium today) and the frame cap. Raising the cap was what fixed coverage
in the first place, so shrinking it to save time would undo that.

## Analysis

`analysing` is **one Bedrock call per reel** carrying every keyframe in order, each labelled
with its `ts_ms`. It returns, via structured output: a reel summary, per-frame description
and verbatim OCR, entities, and `places[]` — each place carrying the text it was read from
and the timestamp that text appeared at. That evidence is what makes "which cafe is in this
reel" answerable and citable; a place with no evidence is downgraded to `inferred` before
storage so it can never be presented as read.

Measured on a real 46s reel: 20 frames, 9,521 input + 3,403 output tokens, ~5p at Sonnet 5
rates, ~40s wall clock. Frame count is the main lever — `-c maxFrames=20`.

Frames are **thinned across the whole reel** rather than truncated at the cap. That matters:
the original code stopped once the cap filled, so a 46s reel was only ever analysed to 28s
and the last third did not exist as far as Ask was concerned.

The model is `-c analysisModel=`, defaulting to `us.anthropic.claude-sonnet-4-6` because
this account is not yet entitled to Sonnet 5 on Bedrock. Two things to know before changing
it: model ids need the `us.` cross-region inference-profile prefix (a bare
`anthropic.claude-...` is rejected for on-demand use), and
`get-foundation-model-availability` reports `AUTHORIZED` for models whose invocation is
then denied — a one-token `invoke-model` is the only reliable entitlement test.

Extraction follows the keyframe spec: scene-cut detection at 0.35, cover
frame always kept, perceptual-hash dedupe at a Hamming distance of 8, capped at 12
frames, resized to a 720px long edge. A clip with no scene cuts and more than 6s of
runtime is sampled evenly instead, so a talking-head reel still yields frames.

Status changes reach the browser over a WebSocket: the media table's DynamoDB stream
drives a broadcaster, so nothing in the pipeline needs to know about connections.
The Library falls back to a 30s poll if the socket drops.

## Prerequisites

- Node 22+ and the AWS CLI, authenticated against the target account
- CDK bootstrapped in the region (`npx cdk bootstrap`) — already done for `us-east-1`

## First run

```bash
cd infra && npm install && npm run deploy
```

Create the single owner account (self-signup is disabled, so this is the only way in).
Pick your own password when prompted — nothing in this repo stores or sees it:

```bash
aws cognito-idp admin-create-user \
  --user-pool-id us-east-1_AkqbUBXmf \
  --username you@example.com \
  --user-attributes Name=email,Value=you@example.com Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL
```

Then deploy the web app and open it:

```bash
cd web && npm install
cd .. && ./scripts/deploy-web.sh
```

That writes `web/.env.local` from the stack outputs, builds the static export, uploads it to
S3 and invalidates the CloudFront cache. It prints the site URL when it finishes. Sign in
with the owner account; Cognito will ask you to replace the temporary password the first
time.

For local development instead, `./scripts/write-web-env.sh && npm --prefix web run dev`
serves the same app on http://localhost:3000, which is also an allowed sign-in origin.

### A note on the reel URL

Reel detail is `/media?id=<uuid>`, not `/media/<uuid>`. The app is a static export with no
server, and a static export cannot serve a route whose values only exist at runtime — reel
ids are created on ingest. Running a server just for prettier URLs was not worth the
infrastructure.

## Ask

`indexing` embeds every keyframe with Titan Multimodal Embeddings — one 1024-dimension
vector covering the frame image *and* its description and OCR text together, which is what
lets a single index serve both written questions and (later) image-to-image Lens search.

Retrieval is **hybrid**: kNN over those vectors plus BM25 over `ocr_text`, `places`,
`description` and `caption`, merged with reciprocal rank fusion. Pure vector search is the
wrong tool on its own here — the questions this app exists to answer are often about exact
strings, like a cafe name on an awning or a street sign, where BM25 wins; paraphrased
questions need the vector side. RRF merges the two without calibrating incomparable scores.

The answer is then generated with the same Claude model, from the retrieved frames only.
Two guardrails, both enforced in code rather than trusted to the prompt:

- A citation is dropped unless it points at a frame that was actually retrieved.
- `answered` is reported false when nothing supports an answer, and the UI says so rather
  than showing a confident-looking guess.

The index is an OpenSearch Serverless **NEXTGEN** collection group, which has no OCU
minimum and scales to zero after ten minutes idle. A CLASSIC collection would bill a 2-OCU
floor (~$350/month) whether used or not, which would dwarf every other cost here — do not
switch the collection group to CLASSIC without deciding to accept that standing charge.

Two consequences worth knowing. Writes are visible on the service's own schedule rather
than immediately, so a question asked seconds after indexing may miss the newest frames.
And the first request after ten idle minutes waits for capacity to spin up, which is why
`DELETE /media/{id}` runs with a longer timeout than the other handlers.

Deleting a reel removes its documents from the index as well as its rows and objects —
otherwise Ask would keep citing a reel that is gone. That delete is idempotent: if it fails
halfway, calling it again finishes the job rather than reporting the media as missing.

## Lens

Drop a screenshot and Lens finds it in your library. It works without a second index:
the frame vectors came from Titan Multimodal applied to the images themselves, so a query
screenshot embeds into the same space and a kNN search is all that is needed. From a frame
already in the library it skips embedding altogether and reuses the stored vector.

A query image is a question, not a reel: it is presigned into a separate `lens/` prefix,
never becomes a media record, and expires after a day on a lifecycle rule. The endpoint
refuses any key outside that prefix, so it cannot be turned into a reader for stored reels.

Measured on a real screenshot: the matching shot came back at 0.94 with the next result at
0.87 — the gap is what makes the top hit meaningful rather than just first.

The second action, **search the web**, identifies what is in the frame and looks it up:
Claude extracts entities under a schema, Brave Web Search runs the query, and Claude
summarises the results. The summary may only use the results returned, and a cited url is
dropped unless the search actually returned it — so this reports what the web says, not
what the model remembers. Entities are marked by whether they were *read* from the frame or
inferred, the same distinction the analysis pass makes for places.

It needs a Brave API key, which is not in this repo and never will be. Create one at
brave.com/search/api, then put it into the secret the stack created:

```bash
aws secretsmanager put-secret-value \
  --secret-id "$(aws cloudformation describe-stacks --stack-name ReelLens \
    --query "Stacks[0].Outputs[?OutputKey=='WebSearchSecretArn'].OutputValue" --output text)" \
  --secret-string 'YOUR_BRAVE_API_KEY'
```

Until then the endpoint returns the entities and the query it would have run, flagged
`configured: false`, instead of failing.

## Plans

Ask answers a question. A plan answers a request — "using all clips create me a travel plan
for Istanbul with all the tips" — by reading across everything you have saved.

It is a different shape of retrieval, not a longer answer. The evidence for a plan is
scattered across clips that answer to different words, so the request is first expanded into
several searches, and their rankings are fused into sixty moments rather than twelve.

Every item in a plan cites the clips it came from, and anything the model writes that the
retrieved moments do not support is dropped before you see it. Asked for Istanbul, a library
of Istanbul clips produced thirty items across eight sections with nothing dropped, prices
copied exactly as the clips showed them. Asked for Tokyo, the same library produced nothing
at all and said so — which is the point. A plan also lists what you asked for that your
clips do not cover.

Plans are built in the background because they take about a minute, and an API Gateway
integration is cut off at thirty seconds. The screen shows the request as building and
fills it in when the worker is done.

## Library thumbnails

The grid draws ~250px tiles, and it used to presign the cover frame itself — 720px for a
reel, 1568px for a carousel slide, because that slide is encoded for the vision pass to read
body text off it. Sixteen tiles came to 1.42 MB.

Each item now gets `thumb.jpg` at 520px on the long edge, which covers a 2x screen and
nothing more: 0.46 MB for the same sixteen tiles, 68% less. Extraction and the slide
download write it inline, and `thumbnail.handler` backfills anything older without
re-running extraction, which would rewrite frame rows and discard the analysis on them.

An uploaded carousel never touches the extractor, so completing that upload asks the
thumbnailer directly; it fails quietly, because an upload should not fail over a grid image.

## Models

Generation runs on the Anthropic API — Opus 5 for the keyframe vision pass, Sonnet 5 for
Ask, plans and Lens, Haiku 4.5 for the query expansion in front of a plan. Embeddings stay
on Bedrock, because Titan Multimodal is a Bedrock model and there is no Anthropic
equivalent, so the stack talks to both.

The move was forced rather than chosen: this AWS account has never been entitled to Sonnet 5
or Opus 5 on Bedrock, and a one-token invoke of either still returns AccessDeniedException.

The API key lives in Secrets Manager under the fixed name `instarag-claude-key`:

```bash
aws secretsmanager put-secret-value --secret-id instarag-claude-key --secret-string <your-key>
```

## Waking the index

The vector index scales to zero when idle, which is what keeps the standing cost near
nothing — and it means the first search after a quiet spell waits tens of seconds for
capacity to come back. Measured: 41s cold, 6s warm, against an API that gives up at 30.

So focusing the question box sends a wake-up first. By the time a question has been typed
the index is up, and the wait has been spent on something nobody was watching. It is
throttled to once every five minutes, and if it fails nothing is lost — the question itself
reports anything genuinely wrong.

Keeping the index permanently warm would also work and is the wrong trade: it would hold
capacity up around the clock for roughly $170/month, against about $2 idle today.

## Durability

`retainData` defaults to on, so the tables, the media bucket and the KMS token key survive
`cdk destroy`, every table that holds anything has point-in-time recovery, and the media
bucket keeps versions. Two lifecycle rules sweep what versioning leaves behind: old versions
after 30 days, and the delete markers a versioned delete leaves in place of the object.

A scratch stack asks for the opposite with `-c retainData=false`, which takes its data with
it rather than leaving resources behind to bill for. The flip side of the default: after a
`cdk destroy` the retained resources are still there, and still cost, until you remove them.

## Alarms

Seven, on one SNS topic. No email address is baked into the repo, so the topic starts with
no subscriber — either deploy with `-c alarmEmail=you@example.com`, or subscribe afterwards:

```bash
aws sns subscribe --topic-arn "$(aws cloudformation describe-stacks --stack-name ReelLens \
  --query "Stacks[0].Outputs[?OutputKey=='AlarmTopicArn'].OutputValue" --output text)" \
  --protocol email --notification-endpoint you@example.com
```

They cover a failed or timed-out ingest, a throw in any pipeline handler, Bedrock rejecting
calls, an hour of unusual token volume, the vector index failing to scale back to zero, and
monthly estimated charges past `-c monthlyBudget` (default $20).

Two caveats worth knowing. `EstimatedCharges` reads 0 while account credits cover the bill,
so the spend alarm is dormant until those run out — the token alarm is the one that works
today. And the pipeline smoke test deliberately fails a reel, so running it sets off the
failure alarm.

## Checks

```bash
cd infra && npm test          # handler logic, perceptual hashing, template assertions
./scripts/smoke.sh            # drives the deployed API handlers against real S3/DynamoDB
./scripts/pipeline-smoke.sh   # pushes a real 4-scene clip through the pipeline (needs Docker)
```

Both scripts create their own media items and delete them again, so they are safe to
re-run against a live library. `pipeline-smoke.sh` also checks the failure path: bytes
that are not really a video must end on `failed` with the reason recorded, never stuck.

`pipeline-smoke.sh` runs the vision pass, so each full run costs a few cents of Bedrock.
Its grounding check leans on the smoke clip being ffmpeg test patterns with no real places
in it: the model must return **no** places at all, which is how we know it is not inventing
venues to be helpful.

Its download-leg check deliberately uses a presigned S3 URL rather than an Instagram
link, so it tests our plumbing and not Instagram's mood. Live reel fetching has to be
checked by hand against a real permalink.

## API

All routes sit behind the Cognito JWT authorizer and take the **id token** in `authorization`.

| Route | Purpose |
|---|---|
| `POST /uploads` | Reserve a media id, return a presigned PUT URL (content-type is signed in) |
| `POST /uploads` with `slides` | Reserve a carousel and return one presigned PUT per slide |
| `POST /media/{id}/complete` | Confirm the object landed, move the item to `queued` |
| `POST /media/url` | Register a pasted instagram.com permalink and start fetching it |
| `GET /media` | Newest-first library listing, `?limit` and `?cursor` |
| `GET /media/{id}` | Record, presigned playback URL, keyframes |
| `DELETE /media/{id}` | Remove the record, its frames and its S3 objects |
| `POST /media/{id}/retry` | Run the pipeline again for a reel that failed |
| `POST /ask` | Ask a question; `mediaId` scopes it to one reel, omit it for the library |
| `GET /threads` | Ask threads, newest first |
| `GET /threads/{id}` | One thread's turns, with their citations |
| `POST /lens/uploads` | Presigned PUT for a screenshot to search with |
| `POST /lens/similar` | Nearest frames to a screenshot, or to a frame already indexed |
| `POST /lens/web` | Identify what is in a frame, then look it up on the web |
| `POST /connect/instagram/start` | Begin OAuth; returns the URL to send the browser to |
| `POST /connect/instagram/exchange` | Finish OAuth: code for a long-lived token |
| `GET /connect/instagram` | Whether an account is connected, and token health |
| `DELETE /connect/instagram` | Forget the token |
| `POST /connect/instagram/sync` | Ingest the connected account's own reels |

The WebSocket endpoint takes the same id token as `?token=…`, because a WebSocket
handshake cannot carry an authorization header.

## Notes on cost and data

- Everything is on-demand: DynamoDB PAY_PER_REQUEST, Lambda, HTTP API, Step Functions.
  Idle cost is effectively the S3 storage of whatever you upload, plus the ECR storage
  for the extraction image.
- Downloading runs at 2048 MB, extraction at 3008 MB, for a few seconds per reel. The
  analysis call is the only per-reel cost that is not trivial: see Analysis above.
- The vector index scales to zero when idle, so an untouched library costs nothing to keep
  searchable beyond the S3 storage. Embedding a reel is a fraction of a cent. Lambda scales vCPU with memory,
  so that is cheaper per reel than a smaller, slower setting.
- The stack defaults to **destroy-on-delete** while it is a skeleton. Deploy with
  `-c retainData=true` once there is data worth keeping, and `-c retentionDays=90` to
  expire media objects.
- Web origins default to `http://localhost:3000`; override with
  `-c webOrigins=https://app.example.com`.

## Teardown

```bash
cd infra && npx cdk destroy ReelLens
```
