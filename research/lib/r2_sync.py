"""Download R2 archive objects to a local cache for DuckDB analysis."""

from __future__ import annotations

import gzip
import json
import subprocess
from pathlib import Path


def wrangler_r2_list(bucket: str, prefix: str) -> list[str]:
    proc = subprocess.run(
        ["npx", "wrangler", "r2", "object", "list", bucket, "--prefix", prefix, "--json"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(proc.stderr or proc.stdout or "wrangler r2 list failed")
    data = json.loads(proc.stdout or "[]")
    if isinstance(data, dict):
        data = data.get("objects", data.get("result", []))
    keys: list[str] = []
    for item in data:
        if isinstance(item, str):
            keys.append(item)
        elif isinstance(item, dict) and item.get("key"):
            keys.append(str(item["key"]))
    return keys


def wrangler_r2_get(bucket: str, key: str, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    proc = subprocess.run(
        ["npx", "wrangler", "r2", "object", "get", bucket, f"--key={key}", f"--file={dest}"],
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"failed to download {key}: {proc.stderr or proc.stdout}")


def sync_prefix(bucket: str, prefix: str, cache_dir: Path, verbose: bool = False) -> list[Path]:
    keys = wrangler_r2_list(bucket, prefix)
    downloaded: list[Path] = []
    for key in keys:
        dest = cache_dir / key
        if dest.exists():
            if verbose:
                print(f"skip existing {key}")
            continue
        if verbose:
            print(f"download {key}")
        wrangler_r2_get(bucket, key, dest)
        downloaded.append(dest)
    return downloaded


def iter_jsonl_gz(path: Path):
    opener = gzip.open if path.suffix == ".gz" or path.name.endswith(".jsonl.gz") else open
    mode = "rt" if path.suffix == ".gz" or path.name.endswith(".jsonl.gz") else "r"
    with opener(path, mode, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)