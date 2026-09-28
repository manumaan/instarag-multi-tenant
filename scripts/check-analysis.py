#!/usr/bin/env python3
"""Checks one GET /media/{id} response for a usable, grounded analysis.

Prints `name=ok` or `name=<what went wrong>` per check, for pipeline-smoke.sh.
The synthetic smoke clip is ffmpeg test patterns with no real places in it, so
the interesting property is that the model did not invent any.
"""
import json
import sys

doc = json.loads(json.load(open(sys.argv[1]))["body"])
media, frames = doc["media"], doc["frames"]
sent = {f["ts_ms"] for f in frames}
places = media.get("places", [])

results = {}
results["summary_present"] = "ok" if (media.get("analysis_summary") or "").strip() else "empty"

undescribed = [f["ts_ms"] for f in frames if not (f.get("description") or "").strip()]
results["frames_all_described"] = "ok" if not undescribed else f"missing:{undescribed}"

ungrounded = [p["name"] for p in places if p["basis"] == "read_from_frame" and not p.get("evidence")]
results["no_ungrounded_place_claims"] = "ok" if not ungrounded else f"claimed:{ungrounded}"

stray = [e["ts_ms"] for p in places for e in p.get("evidence", []) if e["ts_ms"] not in sent]
results["evidence_points_at_real_frames"] = "ok" if not stray else f"stray:{stray}"

for name, value in results.items():
    print(f"{name}={value}")
print(f"places={len(places)} described={len(frames) - len(undescribed)}/{len(frames)}")
