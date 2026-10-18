"""Summarize tickets.csv into summary.json in the current directory."""

import csv
import json
from collections import Counter
from pathlib import Path


def main():
    with Path("tickets.csv").open(encoding="utf-8", newline="") as source:
        tickets = list(csv.DictReader(source))

    summary = {
        "total": len(tickets),
        "total_estimated_hours": sum(
            float(ticket["estimated_hours"]) for ticket in tickets
        ),
        "by_status": dict(Counter(ticket["status"] for ticket in tickets)),
        "high_priority_count": sum(
            ticket["priority"] == "high" for ticket in tickets
        ),
    }
    Path("summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
