import json, sys

path = sys.argv[1] if len(sys.argv) > 1 else "slither-report.json"
with open(path, "r", encoding="utf-8") as fh:
    data = json.load(fh)

detectors = ((data.get("results") or {}).get("detectors") or [])
rows = []
counts = {}
for d in detectors:
    impact = d.get("impact", "Unknown")
    counts[impact] = counts.get(impact, 0) + 1
    rows.append({
        "impact": impact,
        "confidence": d.get("confidence"),
        "check": d.get("check"),
        "description": d.get("description"),
    })

summary = {
    "slither_success": bool(data.get("success", False)),
    "error": data.get("error"),
    "detector_count": len(detectors),
    "counts_by_impact": counts,
    "detectors": rows,
}
print(json.dumps(summary, indent=2))
