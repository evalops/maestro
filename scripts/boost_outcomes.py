#!/usr/bin/env python3
"""Compare observed boost cohorts from the existing local turn telemetry JSONL."""
import argparse
import json
import math
import statistics
from collections import defaultdict


def summarize(records):
    groups = defaultdict(list)
    excluded = 0
    for event in records:
        if event.get("type") != "canonical-turn":
            continue
        # Older records cannot be treated as an unboosted control cohort.
        if not all(isinstance(event.get(key), bool) for key in
                   ("boost_suggested", "boost_requested", "boost_applied")):
            excluded += 1
            continue
        cohort = ("boosted" if event["boost_applied"] else
                  "suggested_unboosted" if event["boost_suggested"] else "ordinary")
        groups[(event.get("model_provider", "unknown"), cohort)].append(event)
    rows = []
    for (provider, cohort), events in sorted(groups.items()):
        costs = [e["reported_cost_usd"] for e in events
                 if isinstance(e.get("reported_cost_usd"), (int, float))
                 and not isinstance(e["reported_cost_usd"], bool)
                 and math.isfinite(e["reported_cost_usd"]) and e["reported_cost_usd"] >= 0]
        durations = [e["total_duration_ms"] for e in events
                     if isinstance(e.get("total_duration_ms"), (int, float))
                     and math.isfinite(e["total_duration_ms"]) and e["total_duration_ms"] >= 0]
        rows.append({"provider": provider, "cohort": cohort, "turns": len(events),
                     "runtime_completion_rate": sum(e.get("status") == "success" for e in events) / len(events),
                     "median_duration_ms": statistics.median(durations) if durations else None,
                     "cost_coverage": len(costs) / len(events),
                     "mean_reported_cost_usd": statistics.mean(costs) if costs else None})
    return {"cohorts": rows, "excluded_legacy_turns": excluded,
            "interpretation": "Observed runtime completion, not verified task success or causal boost benefit. Harder tasks self-select into boost; sampling may differ. Compare matched tasks before changing defaults."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("telemetry", help="Existing telemetry JSONL file")
    args = parser.parse_args()
    with open(args.telemetry, encoding="utf-8") as stream:
        print(json.dumps(summarize(json.loads(line) for line in stream if line.strip()), indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
