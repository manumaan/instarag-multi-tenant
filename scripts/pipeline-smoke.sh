#!/usr/bin/env bash
# Drives a real video through the ingest pipeline and checks what came out.
#
# Uploads a generated multi-scene clip, waits for the state machine to finish,
# then asserts the keyframes, their timestamps and their perceptual hashes look
# like the spec says they should. Cleans up after itself.
#
# NOTE: this runs the Claude vision pass, so a full run costs a few cents of
# Bedrock.
set -euo pipefail

STACK="${STACK:-ReelLens}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

FFMPEG_IMAGE="mwader/static-ffmpeg:7.1@sha256:a8090df5f5608daef387e1b2e93b98aaacb4d92153ad904e7d715c725724fca4"

outputs=$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output json)
fn() { python3 "$SMOKE_DIR/stack-lookup.py" "$STACK" "$1"; }
output() { printf '%s' "$outputs" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='$1'))"; }

FRAMES_TABLE=$(python3 "$SMOKE_DIR/stack-lookup.py" "$STACK" "StorageFramesTable" AWS::DynamoDB::Table)
JOBS_TABLE=$(python3 "$SMOKE_DIR/stack-lookup.py" "$STACK" "StorageJobsTable" AWS::DynamoDB::Table)
BUCKET=$(output MediaBucketName)
FN_CREATE_UPLOAD=$(fn ApiCreateUpload); FN_COMPLETE=$(fn ApiCompleteUpload)
FN_GET=$(fn ApiGetMedia); FN_DELETE=$(fn ApiDeleteMedia); FN_ASK=$(fn ApiAsk)

pass=0; fail=0
check() { if [ "$2" = "$3" ]; then echo "  ok   $1 ($2)"; pass=$((pass+1)); else echo "  FAIL $1: got $2, want $3"; fail=$((fail+1)); fi; }
check_ge() { if [ "$2" -ge "$3" ] 2>/dev/null; then echo "  ok   $1 ($2 >= $3)"; pass=$((pass+1)); else echo "  FAIL $1: got $2, want >= $3"; fail=$((fail+1)); fi; }
inv() { printf '%s' "$2" > "$TMP/event.json"
  aws lambda invoke --function-name "$1" --payload "fileb://$TMP/event.json" "$TMP/out.json" >/dev/null; }
body() { python3 -c "import json;d=json.loads(json.load(open('$TMP/out.json'))['body']);print(d$1)"; }

echo "pipeline smoke test: stack=$STACK region=$AWS_REGION"

echo "building a 4-scene 540x960 clip with ffmpeg"
docker run --rm "$FFMPEG_IMAGE" \
  -f lavfi -i "testsrc=s=540x960:r=24:d=2" \
  -f lavfi -i "smptebars=s=540x960:r=24:d=2" \
  -f lavfi -i "rgbtestsrc=s=540x960:r=24:d=2" \
  -f lavfi -i "testsrc2=s=540x960:r=24:d=2" \
  -filter_complex "[0:v][1:v][2:v][3:v]concat=n=4:v=1:a=0[v]" -map "[v]" \
  -c:v libx264 -pix_fmt yuv420p -movflags frag_keyframe+empty_moov -f mp4 pipe:1 2>/dev/null > "$TMP/clip.mp4"
BYTES=$(wc -c < "$TMP/clip.mp4" | tr -d ' ')
echo "  clip is $BYTES bytes"

inv "$FN_CREATE_UPLOAD" "{\"routeKey\":\"POST /uploads\",\"body\":\"{\\\"filename\\\":\\\"clip.mp4\\\",\\\"contentType\\\":\\\"video/mp4\\\",\\\"bytes\\\":$BYTES}\"}"
MEDIA_ID=$(body "['mediaId']")
curl -s -o /dev/null -X PUT -H 'content-type: video/mp4' --data-binary "@$TMP/clip.mp4" "$(body "['uploadUrl']")"
echo "uploaded as $MEDIA_ID"

inv "$FN_COMPLETE" "{\"routeKey\":\"POST /media/{id}/complete\",\"pathParameters\":{\"id\":\"$MEDIA_ID\"}}"
check "upload completes" "$(body "['status']")" queued

echo "waiting for the pipeline"
START_MS=$(python3 -c "import time; print(int(time.time()*1000) - 60000)")
for _ in $(seq 1 60); do
  inv "$FN_GET" "{\"routeKey\":\"GET /media/{id}\",\"pathParameters\":{\"id\":\"$MEDIA_ID\"}}"
  s=$(body "['media']['status']")
  [ "$s" = "ready" ] || [ "$s" = "failed" ] && break
  sleep 2
done
FINAL=$(body "['media']['status']")
check "reaches ready" "$FINAL" ready
if [ "$FINAL" = "failed" ]; then echo "  error: $(body "['media']['error']" | head -c 400)"; fi

# Extraction can finish inside one poll interval, so the transitions are read
# from the execution history rather than from whatever polling happened to see.
EXEC_ARN=$(aws stepfunctions list-executions --state-machine-arn "$(output StateMachineArn)" \
  --query "executions[?starts_with(name, '$MEDIA_ID')] | [0].executionArn" --output text)
check "one execution started for this media" "$([ "$EXEC_ARN" != "None" ] && echo yes || echo no)" yes
check "execution succeeded" \
  "$(aws stepfunctions describe-execution --execution-arn "$EXEC_ARN" --query status --output text)" SUCCEEDED
STATES=$(aws stepfunctions get-execution-history --execution-arn "$EXEC_ARN" \
  --query "events[?type=='TaskStateEntered'].stateEnteredEventDetails.name" --output text | tr '\t' ' ')
echo "  states entered: $STATES"
for state in StartJob MarkExtracting Extract MarkReady FinishJob; do
  case " $STATES " in *" $state "*) pass=$((pass+1));;
    *) echo "  FAIL pipeline never entered $state"; fail=$((fail+1));; esac
done
echo "  ok   pipeline ran StartJob -> MarkExtracting -> Extract -> MarkReady -> FinishJob"

# The broadcaster is what pushes those transitions to the browser.
BROADCAST_LOGS=$(python3 "$SMOKE_DIR/stack-lookup.py" "$STACK" RealtimeWsBroadcastLogs AWS::Logs::LogGroup)
# No --filter-pattern: CloudWatch tokenises on hyphens, so a UUID never matches
# as a term. Pull the window and grep locally, retrying while logs settle.
PUSHED=""
for _ in $(seq 1 10); do
  PUSHED=$(aws logs filter-log-events --log-group-name "$BROADCAST_LOGS" --start-time "$START_MS" \
    --query 'events[].message' --output text 2>/dev/null | tr -d '\n' || true)
  case "$PUSHED" in *"$MEDIA_ID:ready"*) break;; esac
  sleep 3
done
for status in queued extracting ready; do
  case "$PUSHED" in *"$MEDIA_ID:$status"*) echo "  ok   broadcast the $status transition"; pass=$((pass+1));;
    *) echo "  FAIL no broadcast for the $status transition"; fail=$((fail+1));; esac
done

FRAME_COUNT=$(body "['frames'].__len__()")
check_ge "extracted keyframes" "$FRAME_COUNT" 4
MAX_FRAMES=$(aws lambda get-function-configuration \
  --function-name "$(fn PipelineExtractFrames)" --query 'Environment.Variables.MAX_FRAMES' --output text)
check "frame cap respected (cap $MAX_FRAMES)" \
  "$([ "$FRAME_COUNT" -le "$MAX_FRAMES" ] && echo yes || echo no)" yes
check "first frame is the cover at t=0" "$(body "['frames'][0]['ts_ms']")" 0

python3 - "$TMP/out.json" <<'PY'
import json, sys
frames = json.loads(json.load(open(sys.argv[1]))['body'])['frames']
ts = [f['ts_ms'] for f in frames]
hashes = [f['phash'] for f in frames]
print(f"  frames at {ts}")
print(f"  kinds {[f.get('kind') for f in frames]}")
assert ts == sorted(ts), f"timestamps out of order: {ts}"
assert len(set(hashes)) == len(hashes), f"duplicate hashes survived: {hashes}"
assert all(len(h) == 16 for h in hashes), f"bad hash length: {hashes}"
def ham(a, b): return bin(int(a, 16) ^ int(b, 16)).count('1')
worst = min(ham(a, b) for i, a in enumerate(hashes) for b in hashes[i+1:])
print(f"  closest pair is {worst} bits apart (dedupe threshold is 8)")
assert worst >= 8, "frames within the dedupe threshold were kept"
PY
echo "  ok   keyframes are ordered, unique and past the dedupe threshold"; pass=$((pass+1))

FRAME_URL=$(python3 -c "import json;print(json.loads(json.load(open('$TMP/out.json'))['body'])['frames'][0]['url'])")
curl -s -o "$TMP/frame.jpg" "$FRAME_URL"
DIMS=$(docker run --rm -i --entrypoint /ffprobe "$FFMPEG_IMAGE" -v error -select_streams v:0 \
  -show_entries stream=width,height -of csv=p=0 - < "$TMP/frame.jpg")
# 540x960 scales to 405x720, but the scale filter's -2 rounds the short edge up
# to an even number for chroma alignment, so 406 is the correct answer.
check "cover frame is resized to a 720 long edge" "$DIMS" "406,720"
check "cover frame is a JPEG" "$(head -c 2 "$TMP/frame.jpg" | xxd -p)" "ffd8"

JOB_STATUS=$(aws dynamodb query --table-name "$JOBS_TABLE" --index-name byMedia \
  --key-condition-expression 'media_id = :m' \
  --expression-attribute-values "{\":m\":{\"S\":\"$MEDIA_ID\"}}" \
  --query 'Items[0].status.S' --output text)
check "job row records success" "$JOB_STATUS" succeeded

echo "websocket handshake"
check "rejects a connection with no token" \
  "$(curl -s -o /dev/null -w '%{http_code}' --http1.1 \
     -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
     -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$(output WsUrl | sed 's|^wss://|https://|')")" 401
# A missing identity source is a 401; a token the authorizer denies is a 403.
check "rejects a bogus token" \
  "$(curl -s -o /dev/null -w '%{http_code}' --http1.1 \
     -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13' \
     -H 'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==' "$(output WsUrl | sed 's|^wss://|https://|')?token=not.a.jwt")" 403

echo "analysis: the vision pass fills in descriptions and grounded places"
ANALYSIS=$(python3 "$SMOKE_DIR/check-analysis.py" "$TMP/out.json")
echo "$ANALYSIS" | sed 's/^/  /'
for row in summary_present frames_all_described no_ungrounded_place_claims evidence_points_at_real_frames; do
  got=$(echo "$ANALYSIS" | grep "^$row=" | cut -d= -f2)
  check "$row" "$got" ok
done

echo "download leg: a URL-sourced item is fetched, then extracted"
# Deliberately NOT an instagram.com link: this checks the download plumbing
# (yt-dlp in Lambda, the S3 write, the record update, the handoff to
# extraction) without depending on Instagram. Live reel fetching is checked
# separately, because only Instagram can tell us whether it will serve us.
MEDIA_TABLE=$(python3 "$SMOKE_DIR/stack-lookup.py" "$STACK" "StorageMediaTable" AWS::DynamoDB::Table)
SOURCE_KEY="media/_smoke-source/clip.mp4"
aws s3 cp "$TMP/clip.mp4" "s3://$BUCKET/$SOURCE_KEY" --quiet
SOURCE_URL=$(aws s3 presign "s3://$BUCKET/$SOURCE_KEY" --expires-in 900)
URL_ID=$(python3 -c "import uuid; print(uuid.uuid4())")
NOW=$(python3 -c "import datetime; print(datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z'))")
aws dynamodb put-item --table-name "$MEDIA_TABLE" --item "$(python3 - "$URL_ID" "$NOW" "$SOURCE_URL" <<'ITEM'
import json, sys
mid, now, url = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
    'id': {'S': mid}, 'entity': {'S': 'media'}, 'source': {'S': 'url'},
    'type': {'S': 'reel'}, 'status': {'S': 'queued'}, 'created_at': {'S': now},
    'permalink': {'S': url},
}))
ITEM
)"
aws stepfunctions start-execution --state-machine-arn "$(output StateMachineArn)" \
  --name "$URL_ID-$(date +%s)" \
  --input "{\"mediaId\":\"$URL_ID\",\"source\":\"url\",\"jobExpiresAt\":\"$(python3 -c 'import time;print(int(time.time())+2592000)')\"}" \
  --query executionArn --output text > "$TMP/exec.txt"
for _ in $(seq 1 60); do
  inv "$FN_GET" "{\"routeKey\":\"GET /media/{id}\",\"pathParameters\":{\"id\":\"$URL_ID\"}}"
  s=$(body "['media']['status']")
  [ "$s" = "ready" ] || [ "$s" = "failed" ] && break
  sleep 2
done
check "a fetched item reaches ready" "$(body "['media']['status']")" ready
if [ "$(body "['media']['status']")" = "failed" ]; then echo "  error: $(body "['media'].get('error','')" | head -c 300)"; fi
check "the fetched video is in the media store" "$(body "['media'].get('s3_key','')")" "media/$URL_ID/original.mp4"
check "the fetched video has bytes" "$([ "$(body "['media'].get('bytes',0)")" -gt 0 ] && echo yes || echo no)" yes
check_ge "the fetched video yields keyframes" "$(body "['frames'].__len__()")" 4
URL_STATES=$(aws stepfunctions get-execution-history --execution-arn "$(cat "$TMP/exec.txt")" \
  --query "events[?type=='TaskStateEntered'].stateEnteredEventDetails.name" --output text | tr '\t' ' ')
echo "  states entered: $URL_STATES"
case " $URL_STATES " in *" Download "*) echo "  ok   took the download leg"; pass=$((pass+1));;
  *) echo "  FAIL never entered Download"; fail=$((fail+1));; esac
inv "$FN_DELETE" "{\"routeKey\":\"DELETE /media/{id}\",\"pathParameters\":{\"id\":\"$URL_ID\"}}"
aws s3 rm "s3://$BUCKET/$SOURCE_KEY" --quiet

echo "index + ask: the reel is searchable, and Ask refuses what it cannot support"
# The smoke clip is ffmpeg test patterns. A question about a place has no
# grounded answer, so `answered` must be false — that is the guardrail that
# stops Ask inventing a venue, and it is worth asserting every run.
printf '%s' '{"routeKey":"POST /ask","body":"{\"question\":\"which cafe is shown in this video?\",\"mediaId\":\"MEDIA_ID_HERE\"}"}' \
  | sed "s/MEDIA_ID_HERE/$MEDIA_ID/" > "$TMP/ask.json"
aws lambda invoke --function-name "$FN_ASK" --payload "fileb://$TMP/ask.json" --cli-read-timeout 120 "$TMP/out.json" >/dev/null
ASK=$(python3 "$SMOKE_DIR/check-ask.py" "$TMP/out.json")
echo "$ASK" | sed 's/^/  /'
for row in http_ok refused_without_evidence no_citations_when_unanswered retrieved_this_reel; do
  got=$(echo "$ASK" | grep "^$row=" | cut -d= -f2)
  check "$row" "$got" ok
done

# The positive case, which the refusal check cannot cover: a bug that drops
# every citation would otherwise look like flawless grounding discipline.
printf '%s' '{"routeKey":"POST /ask","body":"{\"question\":\"what colours and patterns appear in this video?\",\"mediaId\":\"MEDIA_ID_HERE\"}"}' \
  | sed "s/MEDIA_ID_HERE/$MEDIA_ID/" > "$TMP/ask2.json"
aws lambda invoke --function-name "$FN_ASK" --payload "fileb://$TMP/ask2.json" --cli-read-timeout 120 "$TMP/out.json" >/dev/null
ASK2=$(python3 "$SMOKE_DIR/check-ask.py" "$TMP/out.json" answerable)
echo "$ASK2" | sed 's/^/  /'
for row in answered_when_supported cited_a_real_moment; do
  got=$(echo "$ASK2" | grep "^$row=" | cut -d= -f2)
  check "$row" "$got" ok
done

echo "failure path: bytes that are not really a video"
head -c 65536 /dev/urandom > "$TMP/junk.mp4"
JUNK_BYTES=$(wc -c < "$TMP/junk.mp4" | tr -d ' ')
inv "$FN_CREATE_UPLOAD" "{\"routeKey\":\"POST /uploads\",\"body\":\"{\\\"filename\\\":\\\"junk.mp4\\\",\\\"contentType\\\":\\\"video/mp4\\\",\\\"bytes\\\":$JUNK_BYTES}\"}"
JUNK_ID=$(body "['mediaId']")
curl -s -o /dev/null -X PUT -H 'content-type: video/mp4' --data-binary "@$TMP/junk.mp4" "$(body "['uploadUrl']")"
inv "$FN_COMPLETE" "{\"routeKey\":\"POST /media/{id}/complete\",\"pathParameters\":{\"id\":\"$JUNK_ID\"}}"
for _ in $(seq 1 45); do
  inv "$FN_GET" "{\"routeKey\":\"GET /media/{id}\",\"pathParameters\":{\"id\":\"$JUNK_ID\"}}"
  s=$(body "['media']['status']")
  [ "$s" = "ready" ] || [ "$s" = "failed" ] && break
  sleep 2
done
check "a broken video ends as failed, not stuck" "$(body "['media']['status']")" failed
JUNK_ERROR=$(body "['media'].get('error','')" | head -c 120)
check "the failure is recorded on the record" "$([ -n "$JUNK_ERROR" ] && echo yes || echo no)" yes
echo "  recorded: $JUNK_ERROR"
JUNK_JOB=$(aws dynamodb query --table-name "$JOBS_TABLE" --index-name byMedia \
  --key-condition-expression 'media_id = :m' \
  --expression-attribute-values "{\":m\":{\"S\":\"$JUNK_ID\"}}" \
  --query 'Items[0].[status.S,expires_at.N]' --output text)
check "job row is marked failed" "$(echo "$JUNK_JOB" | awk '{print $1}')" failed
check "job row carries a TTL" "$([ -n "$(echo "$JUNK_JOB" | awk '{print $2}')" ] && echo yes || echo no)" yes
inv "$FN_DELETE" "{\"routeKey\":\"DELETE /media/{id}\",\"pathParameters\":{\"id\":\"$JUNK_ID\"}}"

echo "cleaning up"
inv "$FN_DELETE" "{\"routeKey\":\"DELETE /media/{id}\",\"pathParameters\":{\"id\":\"$MEDIA_ID\"}}"
check "objects removed" "$(aws s3 ls "s3://$BUCKET/media/$MEDIA_ID/" --recursive | wc -l | tr -d ' ')" 0
LEFTOVER=$(aws dynamodb query --table-name "$FRAMES_TABLE" \
  --key-condition-expression 'media_id = :m' \
  --expression-attribute-values "{\":m\":{\"S\":\"$MEDIA_ID\"}}" --query 'Count' --output text)
check "frame rows removed" "$LEFTOVER" 0
# A reel left in the vector index stays retrievable, so Ask would go on citing
# something the user deleted. The delete must report what it removed.
check "removed from the vector index" \
  "$([ "$(body "['removedFromIndex']" 2>/dev/null || echo 0)" -gt 0 ] && echo yes || echo no)" yes
CAPTION_FACTS_TABLE=$(python3 "$SMOKE_DIR/stack-lookup.py" "$STACK" "StorageCaptionFactsTable" AWS::DynamoDB::Table)
check "caption facts removed" \
  "$(aws dynamodb get-item --table-name "$CAPTION_FACTS_TABLE" --key "{\"media_id\":{\"S\":\"$MEDIA_ID\"}}" --query 'Item' --output text)" None

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
