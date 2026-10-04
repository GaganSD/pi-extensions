#!/usr/bin/env python3
"""Archive collected episodes that cannot be published as complete usage.

Does not overwrite evidence. Does not touch another model's run. After this,
`benchmarks/run.py <model>` will launch those IDs again under the current seal.
Foreign-campaign rows also cannot be skipped, so they are archived too.
"""
import argparse
import hashlib
import json
import shutil
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "benchmarks"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("model", choices=sorted((ROOT / "config.json").exists() and
                                                json.loads((ROOT / "config.json").read_text())["models"]))
    args = parser.parse_args()
    campaign = hashlib.sha256((ROOT / ".cache/manifest.json").read_bytes()).hexdigest()
    episodes = ROOT / args.model / "results/episodes"
    assert episodes.is_dir(), f"No episodes at {episodes}"
    dest = ROOT / ".cache" / f"archive-{args.model}-rerun-{int(time.time())}"
    dest.mkdir(parents=True)
    moved = []
    blocked = []
    for directory in sorted(p for p in episodes.iterdir() if p.is_dir()):
        record_path = directory / "collection.json"
        if not record_path.is_file():
            blocked.append(directory.name + " (partial)")
            continue
        record = json.loads(record_path.read_text())
        unknown = (record.get("usage_evidence") or {}).get("unknown_requests") or 0
        foreign = record.get("campaign_sha256") != campaign
        incomplete = record.get("collector_status") != "collected"
        if incomplete and not foreign:
            blocked.append(directory.name + " (incomplete)")
            continue
        if unknown or foreign or incomplete:
            shutil.move(directory, dest / directory.name)
            moved.append({"id": directory.name, "unknown": unknown, "foreign_campaign": foreign})
    print(json.dumps({"archived": str(dest), "moved": moved, "blocked": blocked}, indent=2))
    if blocked:
        raise SystemExit("Left blocking evidence in place; inspect before another run.")


if __name__ == "__main__":
    main()
