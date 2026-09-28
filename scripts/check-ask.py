#!/usr/bin/env python3
"""Checks one POST /ask response for grounded refusal behaviour.

Called by pipeline-smoke.sh against the synthetic test-pattern clip, where the
only correct answer to "which cafe is shown" is that there isn't one. Prints
`name=ok` or `name=<what went wrong>` per check.
"""
import json
import sys

MODE = sys.argv[2] if len(sys.argv) > 2 else "refusal"
envelope = json.load(open(sys.argv[1]))
results = {}
results["http_ok"] = "ok" if envelope.get("statusCode") == 200 else f"status:{envelope.get('statusCode')}"

body = json.loads(envelope["body"]) if "body" in envelope else {}
if "error" in body:
    results["refused_without_evidence"] = f"api_error:{body['error'][:80]}"
    results["no_citations_when_unanswered"] = "skipped"
    results["retrieved_this_reel"] = "skipped"
elif MODE == "answerable":
    # The positive case. Without it, a bug that drops every citation looks like
    # perfect grounding discipline.
    answered = body.get("answered")
    citations = body.get("citations", [])
    results["answered_when_supported"] = "ok" if answered is True else f"answered:{answered}"
    results["cited_a_real_moment"] = "ok" if citations else "no_citations"
else:
    answered = body.get("answered")
    results["refused_without_evidence"] = "ok" if answered is False else f"answered:{answered}"
    citations = body.get("citations", [])
    results["no_citations_when_unanswered"] = "ok" if not citations else f"cited:{len(citations)}"
    retrieved = body.get("retrieved", [])
    results["retrieved_this_reel"] = "ok" if retrieved else "nothing_retrieved"

for name, value in results.items():
    print(f"{name}={value}")
print(f"answer={(body.get('answer') or '')[:100]}")
