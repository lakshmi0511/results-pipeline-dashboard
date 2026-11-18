#!/usr/bin/env python3
"""Turn raw collector inputs into course-level dashboard data.

    python3 -I build/build.py STATE_DIR ['<status json>']

Reads, from STATE_DIR:
  tool.json       tables scraped from the scoring tool (course list with workflow
                  flags, per-shift checklist, course statistics)
  planner.csv     course release planner
  aftercheck.csv  after sign-off check
  signoff.csv     sign-off / certificate / publishing status

Writes STATE_DIR/data.json (mode 0600) and prints a one-line JSON summary.

Design rules:
  * Standard library only, so it runs anywhere python3 does.
  * Spreadsheet columns are found BY HEADER NAME, never by position: the team
    inserts and reorders columns by hand. A missing column stops the build with
    a message that names the column and lists the headers that were found.
  * Dates are accepted in several common formats (day-first for numeric ones).
  * Only course-level fields and totals are written out. No candidate-level
    data exists in the inputs, and staff names (e.g. "Person Checked") are
    reduced to a yes/no flag.
"""
import csv
import json
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone

STAGES = ["Not started", "Opened", "QP check", "Moderation", "Score summary",
          "Awaiting verify", "Verified"]
# scoring-tool workflow flag -> the stage a course reaches once that flag is set
FLAG_STAGES = [("home", "Opened"), ("qp_check", "QP check"), ("moderation", "Moderation"),
               ("score_summary", "Score summary"), ("signoff", "Awaiting verify"),
               ("verified", "Verified")]

# logical field -> accepted header spellings (compared case/punctuation-insensitively)
COLUMNS = {
    "course_list": {
        "course_id": ["Course ID", "Course Code", "Course"],
        "name": ["Course Name", "Name", "Title"],
        "home": ["Home"],
        "qp_check": ["QP Check", "QP Checked"],
        "moderation": ["Moderation"],
        "score_summary": ["Score Summary"],
        "signoff": ["Signoff", "Sign Off", "Sign-off"],
        "verified": ["Verified"],
    },
    "shift_checklist": {
        "exam_date": ["Exam Date", "Date"],
        "shift": ["Shift", "Session"],
        "registered": ["Registered"],
        "present": ["Present"],
        "status": ["Status"],
    },
    "course_stats": {
        "course_id": ["Course ID", "Course Code"],
        "present": ["Present"],
        "pass": ["Pass", "Passed"],
        "pass_pct": ["Pass %", "Pass Percentage", "Pass Pct"],
    },
    "planner": {
        "course_id": ["Course ID", "Course Code"],
        "name": ["Course Name", "Name"],
        "exam_type": ["Exam Type", "Mode"],
        "on_hold": ["On Hold", "Hold"],
        "forwarded": ["Forwarded to Portal Team", "Forwarded to Portal"],
        "sort_status": ["Sort Status", "Sorting Status"],
    },
    "aftercheck": {
        "course_id": ["Course ID", "Course Code"],
        "exam_date": ["Exam Date"],
        "shared": ["Shared with Faculty", "Shared with Faculty Date", "Shared to Faculty"],
        "signed_off": ["Signed Off", "Signoff", "Signed Off Date"],
        "pass_pct": ["Pass %", "Pass Percentage"],
        "highest": ["Highest Score", "Highest"],
        "uploaded": ["Uploaded"],
        "checked_by": ["Person Checked", "Checked By"],
        "issue": ["Issue Reported", "Issue"],
        "issue_status": ["Issue Status"],
        "cert_shared": ["Shared for Certificate Generation", "Shared for Certificates"],
    },
    "signoff": {
        "course_id": ["Course ID", "Course Code"],
        "cert": ["Certificate Generated", "Certificates Generated"],
        "batch": ["Batch"],
        "live": ["Score Pushed Live", "Scores Pushed Live", "Pushed Live"],
        "announcement": ["Announcement"],
        "sms": ["SMS"],
        "email": ["Email", "E-mail"],
        "coord_mail": ["Coordinator Mail", "Coordinator Email"],
    },
}

DATE_FORMATS = ["%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y", "%d.%m.%Y", "%d/%m/%y", "%Y/%m/%d",
                "%d-%b-%Y", "%d-%b-%y", "%d %b %Y", "%d %B %Y", "%b %d, %Y", "%B %d, %Y",
                "%b %d %Y", "%d-%B-%Y"]
YES = {"yes", "y", "done", "sent", "true", "1", "completed", "complete", "generated", "ok", "x"}
OPEN_ISSUE = {"open", "pending", "in progress", "new", "reopened"}


def die(msg):
    print(f"build.py: {msg}", file=sys.stderr)
    sys.exit(2)


def norm(text):
    return re.sub(r"[^a-z0-9%]+", " ", str(text).strip().lower()).strip()


def parse_date(text):
    s = str(text or "").strip()
    if not s:
        return None
    s = re.sub(r"[T ]\d{1,2}:\d{2}.*$", "", s).strip()  # drop a trailing time
    s = re.sub(r"\s+", " ", s)
    for fmt in DATE_FORMATS:
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            pass
    return None


def truthy(text):
    return norm(text) in YES or parse_date(text) is not None


def to_float(text):
    try:
        return float(str(text).replace("%", "").replace(",", "").strip())
    except ValueError:
        return None


def to_int(text):
    f = to_float(text)
    return int(f) if f is not None else None


class Table:
    """Rows addressed by logical field name, resolved from the header row."""

    def __init__(self, name, headers, rows):
        self.name = name
        self.headers = [str(h).strip() for h in headers]
        index = {}
        for i, h in enumerate(self.headers):
            index.setdefault(norm(h), i)
        self.cols = {}
        for field, names in COLUMNS[name].items():
            pos = next((index[norm(n)] for n in names if norm(n) in index), None)
            if pos is None:
                die(f"{name}: required column '{names[0]}' is missing "
                    f"(also accepted: {names[1:] or 'none'}). Headers found: {self.headers}. "
                    f"If the sheet header was renamed, add the new spelling to COLUMNS in build/build.py.")
            self.cols[field] = pos
        self.rows = [r for r in rows if any(str(c).strip() for c in r)]

    def records(self):
        for row in self.rows:
            rec = {f: (str(row[i]).strip() if i < len(row) and row[i] is not None else "")
                   for f, i in self.cols.items()}
            if "course_id" in rec:
                rec["course_id"] = rec["course_id"].upper()
                if not rec["course_id"]:
                    continue
            yield rec


def load_csv(state, name):
    path = os.path.join(state, f"{name}.csv")
    if not os.path.exists(path):
        die(f"missing input {path} (did the collector read the '{name}' sheet?)")
    with open(path, newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    if not rows:
        die(f"{path} is empty")
    return Table(name, rows[0], rows[1:])


def load_tool(state):
    path = os.path.join(state, "tool.json")
    if not os.path.exists(path):
        die(f"missing input {path} (did the collector read the scoring tool?)")
    with open(path, encoding="utf-8") as f:
        tool = json.load(f)
    tables = tool.get("tables", {})
    out = {}
    for name in ("course_list", "shift_checklist", "course_stats"):
        t = tables.get(name)
        if not t or "headers" not in t:
            die(f"tool.json has no '{name}' table")
        out[name] = Table(name, t["headers"], t.get("rows", []))
    return tool, out


def iso(d):
    return d.isoformat() if d else None


def write_private(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(path, 0o600)


def build(state, status):
    tool, t = load_tool(state)
    planner = load_csv(state, "planner")
    after = load_csv(state, "aftercheck")
    signoff = load_csv(state, "signoff")
    as_of = parse_date(status.get("as_of") or tool.get("as_of") or "") or date.today()

    courses = {}

    def course(cid, name=""):
        c = courses.get(cid)
        if c is None:
            c = courses[cid] = {
                "id": cid, "name": name, "exam_type": "unknown", "on_hold": False,
                "forwarded": False, "sort_status": "", "stage": STAGES[0], "stage_index": 0,
                "in_tool": False, "in_planner": False, "exam_date": None, "shared_on": None,
                "signed_off": False, "signed_off_on": None, "pass_pct": None, "highest": None,
                "uploaded": False, "checked": False, "issue": "", "issue_status": "",
                "issue_open": False, "cert_shared": False, "cert_generated": False, "batch": "",
                "pushed_live_on": None, "live": False, "announced": False, "sms": False,
                "email": False, "coord_mail": False, "present": None, "pass": None,
            }
        if name and not c["name"]:
            c["name"] = name
        return c

    for r in planner.records():
        c = course(r["course_id"], r["name"])
        c["in_planner"] = True
        et = norm(r["exam_type"])
        c["exam_type"] = "online" if "online" in et else ("offline" if "offline" in et else "unknown")
        c["on_hold"] = truthy(r["on_hold"])
        c["forwarded"] = truthy(r["forwarded"])
        c["sort_status"] = r["sort_status"]

    for r in t["course_list"].records():
        c = course(r["course_id"], r["name"])
        c["in_tool"] = True
        for field, stage in FLAG_STAGES:
            if truthy(r[field]):
                c["stage"] = stage
        c["stage_index"] = STAGES.index(c["stage"])

    for r in t["course_stats"].records():
        c = course(r["course_id"])
        c["present"], c["pass"] = to_int(r["present"]), to_int(r["pass"])
        c["pass_pct"] = to_float(r["pass_pct"])

    for r in after.records():
        c = course(r["course_id"])
        c["exam_date"] = parse_date(r["exam_date"]) or c["exam_date"]
        c["shared_on"] = parse_date(r["shared"])
        c["signed_off"] = truthy(r["signed_off"])
        c["signed_off_on"] = parse_date(r["signed_off"])
        pct = to_float(r["pass_pct"])
        if pct is not None:
            c["pass_pct"] = pct
        c["highest"] = to_float(r["highest"])
        c["uploaded"] = truthy(r["uploaded"])
        c["checked"] = bool(r["checked_by"])  # name reduced to a flag on purpose
        c["issue"] = r["issue"]
        c["issue_status"] = r["issue_status"]
        c["issue_open"] = bool(r["issue"]) and (norm(r["issue_status"]) in OPEN_ISSUE or not r["issue_status"])
        c["cert_shared"] = truthy(r["cert_shared"])

    for r in signoff.records():
        c = course(r["course_id"])
        c["cert_generated"] = truthy(r["cert"])
        c["batch"] = r["batch"]
        c["pushed_live_on"] = parse_date(r["live"])
        c["live"] = truthy(r["live"])
        c["announced"] = truthy(r["announcement"])
        c["sms"], c["email"], c["coord_mail"] = truthy(r["sms"]), truthy(r["email"]), truthy(r["coord_mail"])

    ordered = sorted(courses.values(), key=lambda c: c["id"])
    active = [c for c in ordered if not c["on_hold"]]
    ids = lambda cs: [c["id"] for c in cs]  # noqa: E731

    # ---- pipeline milestones, in order ------------------------------------
    milestones = [
        ("Scores loaded", "scores not loaded", lambda c: c["stage_index"] >= STAGES.index("Score summary")),
        ("Shared with faculty", "not shared with faculty", lambda c: c["shared_on"] is not None),
        ("Signed off", "not signed off", lambda c: c["signed_off"]),
        ("Verified", "not verified", lambda c: c["stage"] == "Verified"),
        ("Shared for certificates", "not shared for certificates", lambda c: c["cert_shared"]),
        ("Certificates generated", "certificates not generated", lambda c: c["cert_generated"]),
        ("Scores pushed live", "not pushed live", lambda c: c["live"]),
        ("Announced", "not announced", lambda c: c["announced"]),
    ]
    gaps = []
    for (a, _, fa), (b, neg_b, fb) in zip(milestones, milestones[1:]):
        stuck = [c for c in active if fa(c) and not fb(c)]
        gaps.append({"from": a, "to": b, "label": f"{a}, {neg_b}", "ids": ids(stuck)})

    def row(label, cs, sub=False):
        return {"label": label, "count": len(cs), "ids": ids(cs), "sub": sub}

    loaded = [c for c in active if milestones[0][2](c)]
    release = [
        row("Courses in planner", [c for c in ordered if c["in_planner"]]),
        row("Online exams", [c for c in ordered if c["exam_type"] == "online"], True),
        row("Offline exams", [c for c in ordered if c["exam_type"] == "offline"], True),
        row("On hold", [c for c in ordered if c["on_hold"]]),
        row("Scores loaded in scoring tool", loaded),
        row("Shared with faculty", [c for c in active if c["shared_on"]]),
        row("Signed off by faculty", [c for c in active if c["signed_off"]]),
        row("Signed off, awaiting verification", [c for c in active if c["signed_off"] and c["stage"] != "Verified"], True),
        row("Verified", [c for c in active if c["stage"] == "Verified"]),
        row("Open issues", [c for c in ordered if c["issue_open"]], True),
        row("Shared for certificate generation", [c for c in active if c["cert_shared"]]),
        row("Certificates generated", [c for c in active if c["cert_generated"]]),
        row("Forwarded to portal team", [c for c in active if c["forwarded"]]),
        row("Results published (scores live)", [c for c in active if c["live"]]),
        row("Announcement sent", [c for c in active if c["announced"]], True),
        row("SMS sent", [c for c in active if c["sms"]], True),
        row("Email sent", [c for c in active if c["email"]], True),
        row("Coordinator mail sent", [c for c in active if c["coord_mail"]], True),
    ]

    stage_counts = []
    for s in STAGES:
        on = sum(1 for c in ordered if c["stage"] == s and c["exam_type"] == "online")
        off = sum(1 for c in ordered if c["stage"] == s and c["exam_type"] == "offline")
        other = sum(1 for c in ordered if c["stage"] == s and c["exam_type"] == "unknown")
        stage_counts.append({"stage": s, "online": on, "offline": off, "unknown": other, "total": on + off + other})

    # ---- pending work queue: the next action for every active course -------
    queue = []
    for c in active:
        since, action, owner = None, None, None
        if c["issue_open"]:
            action, owner, since = f"Resolve issue: {c['issue']}", "Results team", c["shared_on"] or c["exam_date"]
        elif c["stage_index"] < STAGES.index("Score summary"):
            nxt = STAGES[c["stage_index"] + 1]
            action, owner, since = f"Finish scoring-tool step: {nxt}", "Scoring team", c["exam_date"]
        elif not c["shared_on"]:
            action, owner, since = "Share scores with faculty", "Results team", c["exam_date"]
        elif not c["signed_off"]:
            action, owner, since = "Chase faculty sign-off", "Course coordinator", c["shared_on"]
        elif c["stage"] != "Verified":
            action, owner, since = "Verify signed-off scores", "Verification team", c["signed_off_on"] or c["shared_on"]
        elif not c["cert_shared"]:
            action, owner, since = "Share for certificate generation", "Results team", c["signed_off_on"]
        elif not c["cert_generated"]:
            action, owner, since = "Generate certificates", "Certificate team", c["signed_off_on"]
        elif not c["live"]:
            action, owner, since = "Push scores live", "Portal team", c["signed_off_on"]
        elif not c["announced"]:
            action, owner, since = "Send results announcement", "Comms team", c["pushed_live_on"]
        if action:
            days = (as_of - since).days if since else None
            queue.append({"id": c["id"], "name": c["name"], "action": action, "owner": owner,
                          "since": iso(since), "days": days})
    queue.sort(key=lambda q: (-(q["days"] if q["days"] is not None else -1), q["id"]))

    reevals = [{"id": c["id"], "name": c["name"], "issue": c["issue"],
                "status": c["issue_status"] or "Open", "open": c["issue_open"]}
               for c in ordered if "eval" in c["issue"].lower()]

    signed = sorted((c for c in ordered if c["signed_off_on"]), key=lambda c: (c["signed_off_on"], c["id"]), reverse=True)
    recent = [{"id": c["id"], "name": c["name"], "date": iso(c["signed_off_on"]), "pass_pct": c["pass_pct"],
               "verified": c["stage"] == "Verified"} for c in signed[:15]]
    per_day = Counter(c["signed_off_on"] for c in signed)
    first = as_of - timedelta(days=20)
    signoffs_per_day = [{"date": iso(first + timedelta(days=i)), "count": per_day.get(first + timedelta(days=i), 0)}
                        for i in range(21)]

    verified = [c for c in active if c["stage"] == "Verified"]
    certificates = {
        "eligible": len(verified),
        "shared": sum(c["cert_shared"] for c in active),
        "generated": sum(c["cert_generated"] for c in active),
        "pending": ids(c for c in active if c["cert_shared"] and not c["cert_generated"]),
        "not_shared": ids(c for c in verified if not c["cert_shared"]),
        "batches": dict(sorted(Counter(c["batch"] for c in active if c["cert_generated"] and c["batch"]).items())),
    }
    gen = [c for c in active if c["cert_generated"]]
    live = [c for c in active if c["live"]]
    publishing = {
        "eligible": len(gen),
        "pushed_live": len(live),
        "announced": sum(c["announced"] for c in live),
        "sms": sum(c["sms"] for c in live),
        "email": sum(c["email"] for c in live),
        "coord_mail": sum(c["coord_mail"] for c in live),
        "pending": {
            "pushed_live": ids(c for c in gen if not c["live"]),
            "announcement": ids(c for c in live if not c["announced"]),
            "sms": ids(c for c in live if not c["sms"]),
            "email": ids(c for c in live if not c["email"]),
            "coord_mail": ids(c for c in live if not c["coord_mail"]),
        },
    }

    by_date = defaultdict(list)
    for c in ordered:
        by_date[c["exam_date"]].append(c)
    by_exam_date = []
    for d in sorted(by_date, key=lambda d: (d is None, d or date.min)):
        cs = by_date[d]
        by_exam_date.append({
            "date": iso(d), "courses": len(cs),
            "online": sum(c["exam_type"] == "online" for c in cs),
            "offline": sum(c["exam_type"] == "offline" for c in cs),
            "loaded": sum(milestones[0][2](c) for c in cs),
            "signed_off": sum(c["signed_off"] for c in cs),
            "verified": sum(c["stage"] == "Verified" for c in cs),
            "published": sum(c["live"] for c in cs),
            "ids": ids(cs),
        })

    # ---- scoring-tool summary ----------------------------------------------
    shifts = list(t["shift_checklist"].records())
    stat_rows = [c for c in ordered if c["present"] is not None]
    present = sum(c["present"] or 0 for c in stat_rows)
    passed = sum(c["pass"] or 0 for c in stat_rows)
    tools = {
        "scraped_at": tool.get("scraped_at"),
        "shifts_total": len(shifts),
        "shifts_completed": sum(1 for s in shifts if norm(s["status"]) in ("completed", "complete", "done")),
        "shifts_open": [{"date": iso(parse_date(s["exam_date"])) or s["exam_date"], "shift": s["shift"],
                         "status": s["status"], "present": to_int(s["present"]), "registered": to_int(s["registered"])}
                        for s in shifts if norm(s["status"]) not in ("completed", "complete", "done")],
        "registered_total": sum(to_int(s["registered"]) or 0 for s in shifts),
        "present_total": sum(to_int(s["present"]) or 0 for s in shifts),
        "courses_with_stats": len(stat_rows),
        "stats_present": present,
        "stats_pass": passed,
        "pass_pct_overall": round(100 * passed / present, 1) if present else None,
        "in_tool_not_planner": ids(c for c in ordered if c["in_tool"] and not c["in_planner"]),
        "in_planner_not_tool": ids(c for c in ordered if c["in_planner"] and not c["in_tool"]),
    }

    summary = {
        "courses": len(ordered),
        "active": len(active),
        "on_hold": len(ordered) - len(active),
        "online": sum(c["exam_type"] == "online" for c in ordered),
        "offline": sum(c["exam_type"] == "offline" for c in ordered),
        "scores_loaded": len(loaded),
        "signed_off": sum(c["signed_off"] for c in active),
        "verified": len(verified),
        "certificates": certificates["generated"],
        "published": len(live),
        "open_issues": sum(c["issue_open"] for c in ordered),
        "queue": len(queue),
    }

    public_fields = ["id", "name", "exam_type", "exam_date", "stage", "stage_index", "on_hold",
                     "shared_on", "signed_off", "signed_off_on", "pass_pct", "highest", "present",
                     "pass", "issue", "issue_status", "issue_open", "checked", "cert_shared",
                     "cert_generated", "batch", "live", "pushed_live_on", "announced", "sms",
                     "email", "coord_mail", "forwarded", "sort_status"]
    course_rows = []
    for c in ordered:
        r = {k: c[k] for k in public_fields}
        for k in ("exam_date", "shared_on", "signed_off_on", "pushed_live_on"):
            r[k] = iso(r[k])
        course_rows.append(r)

    return {
        "schema": 1,
        "built_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "as_of": iso(as_of),
        "status": status,
        "stages": STAGES,
        "summary": summary,
        "tools": tools,
        "courses": course_rows,
        "release": release,
        "stage_counts": stage_counts,
        "gaps": gaps,
        "queue": queue,
        "reevaluations": reevals,
        "recent_signoffs": recent,
        "signoffs_per_day": signoffs_per_day,
        "certificates": certificates,
        "publishing": publishing,
        "by_exam_date": by_exam_date,
    }


def main():
    if len(sys.argv) < 2:
        die("usage: build.py STATE_DIR ['<status json>']")
    state = sys.argv[1]
    try:
        status = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else {}
    except json.JSONDecodeError as e:
        die(f"status argument is not valid JSON: {e}")
    if not os.path.isdir(state):
        die(f"state directory {state} does not exist")
    data = build(state, status)
    write_private(os.path.join(state, "data.json"), json.dumps(data, separators=(",", ":")))
    s = data["summary"]
    print(json.dumps({
        "built_at": data["built_at"], "as_of": data["as_of"],
        "status": status.get("overall", "unknown"),
        "courses": s["courses"], "scores_loaded": s["scores_loaded"], "signed_off": s["signed_off"],
        "verified": s["verified"], "certificates": s["certificates"], "published": s["published"],
        "open_issues": s["open_issues"], "queue": s["queue"],
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
