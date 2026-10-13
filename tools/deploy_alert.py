#!/usr/bin/env python3
"""LLM-free watchdog for the fantasy dashboard deploy (tools/refresh_and_deploy.sh).

Runs as an OpenClaw *command* cron (no model, no subscription) after the 2:00 AM launchd refresh.
Reads logs/last_run.json and prints ONE of:
  * an alert  - the latest run failed (announced once per run), or no run has started in STALE_HOURS
  * a recovery line - the first successful run after an announced failure
  * NO_REPLY  - nothing new (OpenClaw stays silent)
State lives in logs/deploy_alert_state.json so the same failure is never posted twice.

Why: on 2026-10-13 the refresh held the push twice (bye-week test gate) and GitHub Pages quietly served
Week 5 until Jose noticed. The gate doing its job must never be silent.

Env overrides (tests): DEPLOY_ALERT_STATUS, DEPLOY_ALERT_STATE, DEPLOY_ALERT_OUT, DEPLOY_ALERT_NOW (ISO).
"""
import datetime as dt
import json
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATUS = os.environ.get("DEPLOY_ALERT_STATUS", os.path.join(REPO, "logs", "last_run.json"))
STATE = os.environ.get("DEPLOY_ALERT_STATE", os.path.join(REPO, "logs", "deploy_alert_state.json"))
OUT = os.environ.get("DEPLOY_ALERT_OUT", os.path.join(REPO, "logs", "refresh_and_deploy.out"))
STALE_HOURS = 26
LIVE = "https://jangelpicon.github.io/settlers-of-the-gridiron/season.html"


def load(path, default):
    try:
        with open(path) as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def save(path, obj):
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump(obj, f, indent=1)
    os.replace(tmp, path)


def parse_ts(s):
    if not s:
        return None
    s = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", s.strip())  # -0500 -> -05:00 (older fromisoformat needs the colon)
    try:
        t = dt.datetime.fromisoformat(s)
    except ValueError:
        return None
    return t if t.tzinfo else t.replace(tzinfo=dt.datetime.now().astimezone().tzinfo)


def failing_checks(limit=6):
    """Lines like '  FAIL - ...' after the LAST test_gate marker in the deploy .out log."""
    try:
        with open(OUT, errors="replace") as f:
            lines = f.read().splitlines()
    except OSError:
        return []
    start = 0
    for i, ln in enumerate(lines):
        if ln.startswith("=====") and "test_gate" in ln:
            start = i
    fails = [ln.strip()[len("FAIL - "):] for ln in lines[start:] if ln.strip().startswith("FAIL - ")]
    seen, uniq = set(), []
    for f_ in fails:
        if f_ not in seen:
            seen.add(f_)
            uniq.append(f_)
    return uniq[:limit]


def fmt(ts):
    t = parse_ts(ts)
    return t.strftime("%a %b %-d %-I:%M %p CT") if t else (ts or "unknown time")


def main():
    now = parse_ts(os.environ.get("DEPLOY_ALERT_NOW")) or dt.datetime.now().astimezone()
    run = load(STATUS, None)
    state = load(STATE, {})
    if not run:
        key = "missing"
        if state.get("last_alert") != key:
            state["last_alert"] = key
            save(STATE, state)
            print("⚠️ Fantasy dashboard watchdog: logs/last_run.json is missing, so I can't tell whether the overnight refresh ran. Check launchd com.jose.fantasy-refresh-deploy.")
        else:
            print("NO_REPLY")
        return

    started = run.get("started") or ""
    st = parse_ts(started)
    if st and (now - st) > dt.timedelta(hours=STALE_HOURS):
        key = "stale:" + started
        if state.get("last_alert") != key:
            state["last_alert"] = key
            save(STATE, state)
            print(f"⚠️ No fantasy dashboard refresh has run since {fmt(started)} (launchd com.jose.fantasy-refresh-deploy should fire daily at 2:00 AM CT). The live page may be stale: <{LIVE}>")
        else:
            print("NO_REPLY")
        return

    if run.get("result") == "ok":
        last = state.get("last_alert")
        if last and not last.startswith("ok:") and state.get("recovered_for") != last:
            state["recovered_for"] = last
            state["last_alert"] = "ok:" + started
            save(STATE, state)
            sha = (run.get("commit") or "")[:7]
            print(f"✅ Fantasy dashboard refresh recovered: data stamped {run.get('stamp') or fmt(started)} is live{(' (commit ' + sha + ')') if sha else ''}. <{LIVE}>")
        else:
            print("NO_REPLY")
        return

    key = "fail:" + started
    if state.get("last_alert") == key:
        print("NO_REPLY")
        return
    state["last_alert"] = key
    state.pop("recovered_for", None)
    save(STATE, state)
    stage = run.get("stage") or "unknown step"
    note = run.get("note") or ""
    msg = [f"⚠️ **Fantasy dashboard did NOT update.** The refresh that started {fmt(started)} failed at step `{stage}` (exit {run.get('exit')}){(': ' + note) if note else ''}. The live page still shows the last good data: <{LIVE}>"]
    if stage == "test_gate":
        fails = failing_checks()
        if fails:
            msg.append("Failing checks:")
            msg += ["• " + f_ for f_ in fails]
    msg.append("Log: settlers-of-the-gridiron/logs/refresh_and_deploy.out · rerun with tools/refresh_and_deploy.sh after the fix.")
    print("\n".join(msg))


if __name__ == "__main__":
    main()
