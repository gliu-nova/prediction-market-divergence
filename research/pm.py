#!/usr/bin/env python3
"""Local DuckDB research layer: R2 archives → features → D1 indicator_summaries."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

import duckdb
import typer
from rich.console import Console
from rich.progress import Progress

from lib.d1_push import push_indicator_summaries
from lib.features import compute_indicator_summaries, load_snapshots_into_duckdb
from lib.r2_sync import sync_prefix

app = typer.Typer(help="Prediction market research pipeline (R2 → DuckDB → D1)")
console = Console()

DEFAULT_BUCKET = "prediction-market-divergence-history"
DEFAULT_D1 = "prediction-market-divergence"
DEFAULT_CACHE = Path("data/r2-cache")
DEFAULT_DUCKDB = Path("data/research.duckdb")


@app.command("sync-r2")
def sync_r2(
    source: str = typer.Option("all", help="polymarket, kalshi, or all"),
    since: str = typer.Option(..., help="YYYY-MM-DD"),
    until: str | None = typer.Option(None, help="YYYY-MM-DD"),
    bucket: str = typer.Option(DEFAULT_BUCKET),
    cache_dir: Path = typer.Option(DEFAULT_CACHE),
    verbose: bool = typer.Option(False, "--verbose", "-v"),
    dry_run: bool = typer.Option(False, "--dry-run"),
):
    """Download partitioned R2 JSONL.gz archives to local cache."""
    sources = ["polymarket", "kalshi"] if source == "all" else [source]
    end = until or since
    for src in sources:
        prefix = f"{src}/markets/{since}"
        if dry_run:
            console.print(f"[yellow]dry-run[/] would sync s3://{bucket}/{prefix}*")
            continue
        with Progress() as progress:
            task = progress.add_task(f"sync {src}", total=None)
            downloaded = sync_prefix(bucket, prefix, cache_dir, verbose=verbose)
            progress.update(task, completed=1)
        console.print(f"{src}: downloaded {len(downloaded)} objects (since={since}, until={end})")


@app.command("build-features")
def build_features(
    since: str = typer.Option(..., help="YYYY-MM-DD"),
    until: str | None = typer.Option(None),
    cache_dir: Path = typer.Option(DEFAULT_CACHE),
    duckdb_path: Path = typer.Option(DEFAULT_DUCKDB),
    dry_run: bool = typer.Option(False, "--dry-run"),
):
    """Load cached R2 snapshots into DuckDB and compute indicator summaries."""
    computed_at = datetime.now(timezone.utc).isoformat()
    if dry_run:
        console.print(f"[yellow]dry-run[/] would build features since={since} until={until}")
        return
    duckdb_path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(str(duckdb_path))
    try:
        count = load_snapshots_into_duckdb(con, cache_dir, since, until)
        console.print(f"loaded {count} market snapshot rows")
        summaries = compute_indicator_summaries(con, computed_at)
        console.print(f"computed {len(summaries)} indicator summary rows")
    finally:
        con.close()


@app.command("push-d1")
def push_d1(
    since: str = typer.Option(..., help="YYYY-MM-DD — selects rows from DuckDB export"),
    database: str = typer.Option(DEFAULT_D1),
    duckdb_path: Path = typer.Option(DEFAULT_DUCKDB),
    dry_run: bool = typer.Option(False, "--dry-run"),
):
    """Write compact indicator summaries from DuckDB back to D1."""
    if not duckdb_path.exists():
        raise typer.Exit("DuckDB file missing — run build-features first")
    con = duckdb.connect(str(duckdb_path), read_only=True)
    try:
        rows = con.execute("SELECT * FROM indicator_summaries_export").fetchdf().to_dict("records")
    finally:
        con.close()
    if dry_run:
        console.print(f"[yellow]dry-run[/] would push {len(rows)} rows to D1 {database}")
        return
    pushed = push_indicator_summaries(database, rows)
    console.print(f"pushed {pushed} indicator rows to D1")


@app.command("run-daily")
def run_daily(
    since: str | None = typer.Option(None, help="Defaults to yesterday UTC"),
    bucket: str = typer.Option(DEFAULT_BUCKET),
    cache_dir: Path = typer.Option(DEFAULT_CACHE),
    duckdb_path: Path = typer.Option(DEFAULT_DUCKDB),
    database: str = typer.Option(DEFAULT_D1),
    dry_run: bool = typer.Option(False, "--dry-run"),
):
    """Daily batch: sync R2 → DuckDB features → D1 summaries."""
    if since is None:
        since = (datetime.now(timezone.utc).date().isoformat())
    sync_r2(source="all", since=since, until=since, bucket=bucket, cache_dir=cache_dir, verbose=False, dry_run=dry_run)
    build_features(since=since, until=since, cache_dir=cache_dir, duckdb_path=duckdb_path, dry_run=dry_run)
    push_d1(since=since, database=database, duckdb_path=duckdb_path, dry_run=dry_run)
    console.print("[green]daily research pipeline complete[/]")


@app.command("status")
def status(
    duckdb_path: Path = typer.Option(DEFAULT_DUCKDB),
    cache_dir: Path = typer.Option(DEFAULT_CACHE),
):
    """Show local research layer state."""
    cache_files = list(cache_dir.rglob("*.jsonl.gz")) if cache_dir.exists() else []
    console.print(f"R2 cache files: {len(cache_files)} under {cache_dir}")
    if duckdb_path.exists():
        con = duckdb.connect(str(duckdb_path), read_only=True)
        try:
            snaps = con.execute("SELECT COUNT(*) FROM market_snapshots").fetchone()[0]
            indicators = con.execute("SELECT COUNT(*) FROM indicator_summaries_export").fetchone()[0]
            console.print(f"DuckDB snapshots: {snaps}, indicator rows: {indicators}")
        except duckdb.CatalogException:
            console.print("DuckDB exists but no research tables yet")
        finally:
            con.close()
    else:
        console.print("DuckDB: not initialized")


if __name__ == "__main__":
    app()