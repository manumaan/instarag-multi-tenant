#!/usr/bin/env bash
# End-to-end check of the deployed API against real S3 and DynamoDB.
#
# Invokes each handler with a synthetic API Gateway event, so it exercises the
# Lambdas, IAM policies, presigned URLs and tables without needing a signed-in
# browser session. Cleans up everything it creates.
set -euo pipefail

STACK="${STACK:-ReelLens}"
export AWS_REGION="${AWS_REGION:-us-east-1}"
SMOKE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

outputs=$(aws cloudformation describe-stacks --stack-name "$STACK" --query 'Stacks[0].Outputs' --output json)

fn() { python3 "$SMOKE_DIR/stack-lookup.py" "$STACK" "$1"; }
output() { printf '%s' "$outputs" | python3 -c "import json,sys; print(next(o['OutputValue'] for o in json.load(sys.stdin) if o['OutputKey']=='$1'))"; }

BUCKET=$(output MediaBucketName)
FN_CREATE_UPLOAD=$(fn ApiCreateUpload)
FN_COMPLETE=$(fn ApiCompleteUpload)
FN_FROM_URL=$(fn ApiCreateFromUrl)
FN_LIST=$(fn ApiListMedia)
FN_GET=$(fn ApiGetMedia)
FN_DELETE=$(fn ApiDeleteMedia)

pass=0; fail=0
inv() { # inv <fn> <event-json>
  printf '%s' "$2" > "$TMP/event.json"
  aws lambda invoke --function-name "$1" --payload "fileb://$TMP/event.json" "$TMP/out.json" >/dev/null
  if ! python3 -c "import json;d=json.load(open('$TMP/out.json'));d['statusCode']" 2>/dev/null; then
    echo "  handler error: $(cat "$TMP/out.json")"; return 1
  fi
}
status() { python3 -c "import json;print(json.load(open('$TMP/out.json'))['statusCode'])"; }
body()   { python3 -c "import json;print(json.loads(json.load(open('$TMP/out.json'))['body'])$1)"; }
check()  { # check <label> <actual> <expected>
  if [ "$2" = "$3" ]; then echo "  ok   $1 ($2)"; pass=$((pass+1));
  else echo "  FAIL $1: got $2, want $3"; fail=$((fail+1)); fi
}

echo "smoke test: stack=$STACK region=$AWS_REGION"

# Count what is already there: this runs against a real library, not a fixture.
inv "$FN_LIST" '{"routeKey":"GET /media","queryStringParameters":{"limit":"100"}}'
BASELINE=$(body "['items'].__len__()")
echo "library already holds $BASELINE item(s)"

head -c 65536 /dev/urandom > "$TMP/clip.mp4"
BYTES=$(wc -c < "$TMP/clip.mp4" | tr -d ' ')

echo "POST /uploads"
inv "$FN_CREATE_UPLOAD" '{"routeKey":"POST /uploads","body":"{\"filename\":\"x.txt\",\"contentType\":\"text/plain\",\"bytes\":10}"}'
check "rejects unsupported content type" "$(status)" 400
inv "$FN_CREATE_UPLOAD" '{"routeKey":"POST /uploads","body":"{\"filename\":\"big.mp4\",\"contentType\":\"video/mp4\",\"bytes\":999999999}"}'
check "rejects oversized file" "$(status)" 400
inv "$FN_CREATE_UPLOAD" "{\"routeKey\":\"POST /uploads\",\"body\":\"{\\\"filename\\\":\\\"clip.mp4\\\",\\\"contentType\\\":\\\"video/mp4\\\",\\\"bytes\\\":$BYTES}\"}"
check "accepts an mp4" "$(status)" 200
MEDIA_ID=$(body "['mediaId']"); UPLOAD_URL=$(body "['uploadUrl']")
check "starts as awaiting_upload" "$(body "['media']['status']")" awaiting_upload

echo "presigned PUT"
check "wrong content-type is refused" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: text/plain' --data-binary "@$TMP/clip.mp4" "$UPLOAD_URL")" 403
check "signed content-type is accepted" \
  "$(curl -s -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: video/mp4' --data-binary "@$TMP/clip.mp4" "$UPLOAD_URL")" 200

echo "POST /media/{id}/complete"
inv "$FN_COMPLETE" "{\"routeKey\":\"POST /media/{id}/complete\",\"pathParameters\":{\"id\":\"$MEDIA_ID\"}}"
check "queues the media" "$(body "['status']")" queued
check "records the real object size" "$(body "['bytes']")" "$BYTES"
# Completing twice must not launch a second pipeline run. The status itself is
# not stable to assert on: these are random bytes, so extraction fails fast and
# the record may legitimately already read `failed` by now.
inv "$FN_COMPLETE" "{\"routeKey\":\"POST /media/{id}/complete\",\"pathParameters\":{\"id\":\"$MEDIA_ID\"}}"
check "second completion returns the same record" "$(body "['id']")" "$MEDIA_ID"
check "second completion starts no second run" \
  "$(aws stepfunctions list-executions --state-machine-arn "$(output StateMachineArn)" \
     --query "length(executions[?starts_with(name, '$MEDIA_ID')])" --output text)" 1

echo "POST /media/url"
inv "$FN_FROM_URL" '{"routeKey":"POST /media/url","body":"{\"url\":\"https://www.instagram.com/reel/Cx1y2z3AbCd/?igsh=zzz\"}"}'
check "accepts a reel permalink" "$(status)" 200
URL_ID=$(body "['mediaId']")
check "normalises the permalink" "$(body "['media']['permalink']")" "https://www.instagram.com/reel/Cx1y2z3AbCd/"
inv "$FN_FROM_URL" '{"routeKey":"POST /media/url","body":"{\"url\":\"https://example.com/reel/abcdef/\"}"}'
check "rejects a non-Instagram link" "$(status)" 400

echo "GET /media"
inv "$FN_LIST" '{"routeKey":"GET /media","queryStringParameters":{"limit":"100"}}'
check "lists both new items" "$(body "['items'].__len__()")" "$((BASELINE + 2))"

echo "GET /media/{id}"
inv "$FN_GET" "{\"routeKey\":\"GET /media/{id}\",\"pathParameters\":{\"id\":\"$MEDIA_ID\"}}"
check "returns the record" "$(status)" 200
check "has no keyframes yet" "$(body "['frames'].__len__()")" 0
check "playback url serves the bytes" "$(curl -s -o /dev/null -w '%{size_download}' "$(body "['playbackUrl']")")" "$BYTES"
inv "$FN_GET" '{"routeKey":"GET /media/{id}","pathParameters":{"id":"does-not-exist"}}'
check "404s an unknown id" "$(status)" 404

echo "DELETE /media/{id}"
for id in "$MEDIA_ID" "$URL_ID"; do
  inv "$FN_DELETE" "{\"routeKey\":\"DELETE /media/{id}\",\"pathParameters\":{\"id\":\"$id\"}}"
  check "deletes $id" "$(status)" 200
done
check "objects removed from S3" "$(aws s3 ls "s3://$BUCKET/media/$MEDIA_ID/" | wc -l | tr -d ' ')" 0
inv "$FN_LIST" '{"routeKey":"GET /media","queryStringParameters":{"limit":"100"}}'
check "library is back to its baseline" "$(body "['items'].__len__()")" "$BASELINE"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
