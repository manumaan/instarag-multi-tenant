#!/usr/bin/env python3
"""Resolves a stack resource's physical id from a logical-id prefix.

Paginates, which matters: this stack passed 100 resources and both
`list-stack-resources` and `lambda list-functions` silently return only the
first page, so an unpaginated lookup started failing to find newer functions.

Usage: stack-lookup.py <stack> <logical-id-prefix> [resource-type]
"""
import json
import subprocess
import sys

stack, prefix = sys.argv[1], sys.argv[2]
resource_type = sys.argv[3] if len(sys.argv) > 3 else "AWS::Lambda::Function"

token, matches = None, []
while True:
    cmd = ["aws", "cloudformation", "list-stack-resources", "--stack-name", stack, "--output", "json"]
    if token:
        cmd += ["--starting-token", token]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        sys.exit(result.stderr.strip()[:200])
    page = json.loads(result.stdout or "{}")
    for row in page.get("StackResourceSummaries", []):
        if row["ResourceType"] == resource_type and row["LogicalResourceId"].startswith(prefix):
            matches.append(row["PhysicalResourceId"])
    token = page.get("NextToken")
    if not token:
        break

if not matches:
    sys.exit(f"no {resource_type} with logical id starting {prefix}")
print(matches[0])
