#!/usr/bin/env python3
"""Generate deterministic, entirely fictional sample inputs for the dashboard.

Writes four files next to this script, in the same shapes the real sources
produce:

  tool.json       tables scraped from the (fictional) web scoring tool
  planner.csv     course release planner sheet
  aftercheck.csv  after sign-off check sheet
  signoff.csv     sign-off / publishing status sheet

Every course code, course name, checker label and number here is invented.
The output is seeded, so running it twice gives byte-identical files.

The spreadsheets deliberately mimic hand-edited sheets: columns are in a
different order in each file, there is an extra "Notes" column the build does
not use, and dates are written in several formats.
"""
import csv
import json
import os
import random
from datetime import date, timedelta

SEED = 20261116
AS_OF = date(2026, 11, 16)  # the "today" the sample data is written for
SITTINGS = [
    date(2026, 10, 17), date(2026, 10, 18),
    date(2026, 10, 24), date(2026, 10, 25),
    date(2026, 11, 1), date(2026, 11, 2),
]
N_COURSES = 120
HERE = os.path.dirname(os.path.abspath(__file__))

DEPTS = {
    "ME": ["Thermal Systems", "Rotor Dynamics", "Machine Elements", "Tribology", "Heat Exchanger Design"],
    "CS": ["Compiler Craft", "Distributed Ledgers", "Graph Algorithms", "Systems Programming", "Program Verification"],
    "EE": ["Power Electronics", "Signal Processing", "Control Loops", "Microgrid Design", "Antenna Theory"],
    "CE": ["Soil Mechanics", "Bridge Loading", "Hydraulic Structures", "Urban Drainage", "Concrete Mix Design"],
    "CH": ["Reactor Kinetics", "Separation Processes", "Polymer Processing", "Mass Transfer", "Process Safety"],
    "BT": ["Enzyme Engineering", "Bioprocess Scale-up", "Cell Signalling", "Protein Folding", "Fermentation Design"],
    "MA": ["Linear Algebra", "Stochastic Processes", "Numerical Methods", "Graph Theory", "Optimisation"],
    "PH": ["Quantum Optics", "Solid State Physics", "Plasma Physics", "Statistical Mechanics", "Acoustics"],
    "HS": ["Technical Writing", "Design Thinking", "Behavioural Economics", "Urban Sociology", "Ethics in Engineering"],
    "MS": ["Supply Chain Analytics", "Operations Research", "Project Appraisal", "Service Design", "Pricing Strategy"],
}
PREFIXES = ["Introduction to", "Foundations of", "Applied", "Principles of", "Advanced", "Practical"]
ISSUES = ["Re-evaluation request", "Score mismatch", "Missing answer script scan", "Re-evaluation request"]
CHECKERS = [f"Reviewer-{i:02d}" for i in range(1, 7)]  # placeholder labels, not people


def fmt_dmy(d):        # 03/11/2026
    return d.strftime("%d/%m/%Y")


def fmt_dmon(d):       # 3-Nov-2026
    return f"{d.day}-{d.strftime('%b-%Y')}"


def fmt_iso(d):        # 2026-11-03
    return d.isoformat()


def fmt_mdy(d):        # Nov 3, 2026
    return f"{d.strftime('%b')} {d.day}, {d.year}"


def clamp_date(d):
    return min(d, AS_OF)


def main():
    rnd = random.Random(SEED)

    # ---- invent the courses ------------------------------------------------
    codes, courses = set(), []
    depts = list(DEPTS)
    while len(courses) < N_COURSES:
        dept = rnd.choice(depts)
        code = f"{dept}{rnd.randint(1, 4)}{rnd.randint(0, 9)}{rnd.randint(0, 9)}"
        if code in codes:
            continue
        codes.add(code)
        name = f"{rnd.choice(PREFIXES)} {rnd.choice(DEPTS[dept])}"
        exam = rnd.choice(SITTINGS)
        days = (AS_OF - exam).days
        # progress along the full pipeline, 0..12 (older exams are further along)
        p = round(days * 0.42 + rnd.gauss(0, 2.4)) - 1
        p = max(0, min(12, p))
        courses.append({
            "id": code, "name": name, "exam": exam, "p": p,
            "shift": rnd.choice(["FN", "AN"]),
            "online": rnd.random() < 0.7,
            "on_hold": rnd.random() < 0.04,
            "registered": int(rnd.lognormvariate(6.2, 0.9)) + 25,
        })
    courses.sort(key=lambda c: c["id"])

    # a few hand-made inconsistencies, so the "gap" lists have something in them
    for c in rnd.sample(courses, 4):
        c["glitch"] = rnd.choice(["signed_not_in_tool", "cert_without_share"])

    # ---- web scoring tool tables -------------------------------------------
    course_list, stats = [], []
    for c in courses:
        p = c["p"]
        flags = [p >= 1, p >= 2, p >= 3, p >= 4, p >= 6, p >= 7]
        if c.get("glitch") == "signed_not_in_tool" and p >= 6:
            flags[4] = flags[5] = False
        course_list.append([c["id"], c["name"]] + ["Yes" if f else "No" for f in flags])
        if p >= 4:
            present = int(c["registered"] * rnd.uniform(0.62, 0.93))
            rate = rnd.uniform(0.38, 0.92)
            passed = int(present * rate)
            c["present"], c["pass"] = present, passed
            c["pass_pct"] = round(100 * passed / present, 1) if present else 0.0
            c["highest"] = rnd.randint(78, 100)
            stats.append([c["id"], str(present), str(passed), f"{c['pass_pct']:.1f}"])

    shifts = []
    for d in SITTINGS:
        for s in ("FN", "AN"):
            group = [c for c in courses if c["exam"] == d and c["shift"] == s]
            if not group:
                continue
            loaded = sum(1 for c in group if c["p"] >= 4)
            status = "Completed" if loaded == len(group) else ("In progress" if loaded else "Pending")
            shifts.append([
                fmt_iso(d), s, str(len(group)),
                str(sum(c["registered"] for c in group)),
                str(sum(c.get("present", int(c["registered"] * 0.8)) for c in group)),
                status,
            ])

    tool = {
        "source": "sample",
        "as_of": AS_OF.isoformat(),
        "scraped_at": f"{AS_OF.isoformat()}T09:30:00+05:30",
        "tables": {
            "course_list": {
                "headers": ["Course ID", "Course Name", "Home", "QP Check", "Moderation",
                            "Score Summary", "Signoff", "Verified"],
                "rows": course_list,
            },
            "shift_checklist": {
                "headers": ["Exam Date", "Shift", "Courses", "Registered", "Present", "Status"],
                "rows": shifts,
            },
            "course_stats": {
                "headers": ["Course ID", "Present", "Pass", "Pass %"],
                "rows": stats,
            },
        },
    }
    with open(os.path.join(HERE, "tool.json"), "w", encoding="utf-8") as f:
        json.dump(tool, f, indent=1)
        f.write("\n")

    # ---- planner.csv ---------------------------------------------------------
    with open(os.path.join(HERE, "planner.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Sort Status", "Course ID", "Course Name", "Notes", "Exam Type", "On Hold",
                    "Forwarded to Portal Team"])
        for c in courses:
            sort = "Sorted" if c["p"] >= 5 else ("Not required" if not c["online"] else "Pending")
            w.writerow([
                sort, c["id"], c["name"],
                "awaiting answer key" if c["on_hold"] else "",
                "Online" if c["online"] else "Offline",
                "Yes" if c["on_hold"] else "No",
                "Yes" if c["p"] >= 9 else "No",
            ])

    # ---- aftercheck.csv ------------------------------------------------------
    with open(os.path.join(HERE, "aftercheck.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Course ID", "Exam Date", "Shared with Faculty", "Signed Off", "Pass %",
                    "Highest Score", "Uploaded", "Notes", "Person Checked", "Issue Reported",
                    "Issue Status", "Shared for Certificate Generation"])
        for c in courses:
            p = c["p"]
            fmt = fmt_dmy if rnd.random() < 0.7 else fmt_dmon
            shared = clamp_date(c["exam"] + timedelta(days=rnd.randint(4, 8))) if p >= 5 else None
            signed = None
            if p >= 6 and shared:
                signed = clamp_date(shared + timedelta(days=rnd.randint(1, 5)))
            if c.get("glitch") == "signed_not_in_tool" and p >= 6 and not signed:
                signed = shared
            issue, istatus = "", ""
            if p >= 5 and rnd.random() < 0.12:
                issue = rnd.choice(ISSUES)
                istatus = "Resolved" if rnd.random() < 0.55 else "Open"
            cert_share = p >= 8 and c.get("glitch") != "cert_without_share"
            w.writerow([
                c["id"], fmt(c["exam"]),
                fmt(shared) if shared else "",
                fmt(signed) if signed else "",
                f"{c['pass_pct']:.1f}" if "pass_pct" in c else "",
                str(c["highest"]) if "highest" in c else "",
                "Yes" if p >= 4 else "",
                "",
                rnd.choice(CHECKERS) if p >= 6 else "",
                issue, istatus,
                "Yes" if cert_share else "",
            ])

    # ---- signoff.csv ---------------------------------------------------------
    batch_of = {d: f"B{i + 1}" for i, d in enumerate(SITTINGS)}
    with open(os.path.join(HERE, "signoff.csv"), "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["Course ID", "Certificate Generated", "Batch", "Score Pushed Live",
                    "Announcement", "SMS", "Email", "Coordinator Mail"])
        for c in courses:
            p = c["p"]
            cert = p >= 9 or (c.get("glitch") == "cert_without_share" and p >= 7)
            live = clamp_date(c["exam"] + timedelta(days=rnd.randint(12, 20))) if p >= 10 else None
            fmt = fmt_iso if rnd.random() < 0.6 else fmt_mdy
            comms = [p >= 12 or (p == 11 and rnd.random() < 0.5) for _ in range(3)]
            w.writerow([
                c["id"],
                "Yes" if cert else "No",
                batch_of[c["exam"]] if cert else "",
                fmt(live) if live else "",
                "Done" if p >= 11 else "",
                "Sent" if comms[0] else "",
                "Sent" if comms[1] else "",
                "Sent" if comms[2] else "",
            ])

    print(json.dumps({"courses": len(courses), "sittings": len(SITTINGS), "as_of": AS_OF.isoformat(),
                      "files": ["tool.json", "planner.csv", "aftercheck.csv", "signoff.csv"]}))


if __name__ == "__main__":
    main()
