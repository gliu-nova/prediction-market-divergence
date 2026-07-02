"""Push compact indicator summaries to remote D1 via wrangler."""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path


def push_indicator_summaries(database: str, rows: list[dict], batch_size: int = 100) -> int:
    if not rows:
        return 0
    written = 0
    for i in range(0, len(rows), batch_size):
        chunk = rows[i : i + batch_size]
        statements = []
        for r in chunk:
            statements.append(
                "INSERT INTO indicator_summaries "
                "(match_key, venue, computed_at, prob_change_1h, prob_change_24h, max_gap_30d, "
                "spread_p50, volume_p50, similar_events_count, reversion_rate, payload_json) "
                f"VALUES ({sql_quote(r['match_key'])}, {sql_quote(r['venue'])}, {sql_quote(r['computed_at'])}, "
                f"{sql_num(r.get('prob_change_1h'))}, {sql_num(r.get('prob_change_24h'))}, {sql_num(r.get('max_gap_30d'))}, "
                f"{sql_num(r.get('spread_p50'))}, {sql_num(r.get('volume_p50'))}, "
                f"{sql_num(r.get('similar_events_count'))}, {sql_num(r.get('reversion_rate'))}, NULL) "
                "ON CONFLICT(match_key, venue, computed_at) DO UPDATE SET "
                "prob_change_1h = excluded.prob_change_1h, "
                "prob_change_24h = excluded.prob_change_24h, "
                "max_gap_30d = excluded.max_gap_30d, "
                "volume_p50 = excluded.volume_p50;"
            )
        sql = "\n".join(statements)
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as fh:
            fh.write(sql)
            path = Path(fh.name)
        try:
            proc = subprocess.run(
                ["npx", "wrangler", "d1", "execute", database, "--remote", f"--file={path}"],
                capture_output=True,
                text=True,
                check=False,
            )
            if proc.returncode != 0:
                raise RuntimeError(proc.stderr or proc.stdout)
            written += len(chunk)
        finally:
            path.unlink(missing_ok=True)
    return written


def sql_quote(value: str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def sql_num(value) -> str:
    if value is None:
        return "NULL"
    return str(float(value))