"""Summarize tasks.csv into summary.json in this script's directory."""

import csv
import json
from decimal import Decimal
from pathlib import Path


def json_number(value):
    """Keep whole hours as integers and serialize fractional hours as numbers."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    raise TypeError(f"Cannot serialize {type(value).__name__}")


def main():
    directory = Path(__file__).resolve().parent
    summary = {
        "total_records": 0,
        "total_hours": Decimal(0),
        "by_status": {},
    }

    with (directory / "tasks.csv").open(encoding="utf-8-sig", newline="") as source:
        for row in csv.DictReader(source):
            hours = Decimal(row["hours"])
            status = row["status"]
            group = summary["by_status"].setdefault(
                status, {"records": 0, "hours": Decimal(0)}
            )
            summary["total_records"] += 1
            summary["total_hours"] += hours
            group["records"] += 1
            group["hours"] += hours

    output = json.dumps(summary, ensure_ascii=False, indent=2, default=json_number)
    (directory / "summary.json").write_text(output + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
