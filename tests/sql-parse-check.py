#!/usr/bin/env python3
"""
PostgreSQL syntax gate for the Supabase migrations.

`pglast` binds libpg_query -- the actual PostgreSQL grammar -- so this catches
syntax errors in both plain SQL statements and PL/pgSQL bodies (DO blocks and
SECURITY DEFINER functions) without needing a database server.

What it proves: every statement in the three migrations parses as valid
PostgreSQL 15-era syntax.

What it does NOT prove: that the statements execute successfully against your
schema. Type resolution, constraint conflicts and RLS behaviour are decided at
plan/execution time. See CUSTOMER_ACCOUNTS_AND_SECURITY.md section 3 for the
queries to run against a real staging project.

Usage:
    pip install pglast
    python3 tests/sql-parse-check.py
"""

import glob
import os
import re
import sys

try:
    import pglast
except ImportError:
    sys.exit("pglast is not installed. Run: pip install pglast")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MIGRATIONS = os.path.join(ROOT, "supabase", "migrations")

DO_RE = re.compile(r"DO\s+\$\$.*?\$\$\s*;", re.S)
FN_RE = re.compile(
    r"CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w\.]+)\s*\(.*?\)"
    r"[\s\S]*?AS\s+\$\$.*?\$\$[\s\S]*?;",
    re.S,
)

failed = 0
checked = 0

for path in sorted(glob.glob(os.path.join(MIGRATIONS, "*.sql"))):
    name = os.path.basename(path)
    with open(path, encoding="utf-8") as fh:
        source = fh.read()

    print(f"\n=== {name} ===")

    # 1. Whole file as SQL. Function/DO bodies are opaque strings here.
    try:
        statements = pglast.parse_sql(source)
        checked += 1
        print(f"  OK   {len(statements)} SQL statements")
    except Exception as exc:  # noqa: BLE001 - report and continue
        failed += 1
        print(f"  FAIL file does not parse: {str(exc)[:400]}")

    # 2. Every PL/pgSQL body, parsed by libpg_query's procedural grammar.
    for index, match in enumerate(DO_RE.finditer(source), 1):
        try:
            pglast.parse_plpgsql(match.group(0))
            checked += 1
            print(f"  OK   DO block #{index}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"  FAIL DO block #{index}: {str(exc)[:400]}")

    for match in FN_RE.finditer(source):
        try:
            pglast.parse_plpgsql(match.group(0))
            checked += 1
            print(f"  OK   {match.group(1)}")
        except Exception as exc:  # noqa: BLE001
            failed += 1
            print(f"  FAIL {match.group(1)}: {str(exc)[:400]}")

print(f"\n=== {checked} parsed, {failed} failed ===")
if failed:
    sys.exit(1)
