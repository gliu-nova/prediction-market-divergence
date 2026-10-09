"""Download R2 archive objects to a local cache for DuckDB analysis."""

from __future__ import annotations

import gzip
import json
import os
import subprocess
import urllib.error
import urllib.request
from collections.abc import Callable, Mapping
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import quote, urlencode

API_BASE = "https://api.cloudflare.com/client/v4"
ARCHIVE_SUFFIX = ".jsonl.gz"
MAX_LIST_PAGES = 100

RestFetch = Callable[[str, dict[str, str]], tuple[int, bytes]]
RunCommand = Callable[..., subprocess.CompletedProcess[str]]


def manifest_object_key(prefix: str) -> str:
    return f"{prefix.rstrip('/')}/manifest.json"


def merge_archive_keys(*groups: list[str]) -> list[str]:
    """Union archive keys. Manifest entries come first. Skip the index object."""
    merged: list[str] = []
    seen: set[str] = set()
    for group in groups:
        for key in group:
            if not key.endswith(ARCHIVE_SUFFIX) or key in seen:
                continue
            seen.add(key)
            merged.append(key)
    return merged


def parse_manifest_body(body: bytes) -> list[str]:
    try:
        payload = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return []
    if not isinstance(payload, dict):
        return []
    raw = payload.get("keys")
    if not isinstance(raw, list):
        return []
    return [key for key in raw if isinstance(key, str) and key]


def parse_rest_list_body(body: bytes) -> tuple[list[str], str | None]:
    try:
        payload = json.loads(body.decode("utf-8") or "{}")
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"R2 list returned non-JSON: {body[:300]!r}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError("R2 list returned an unexpected payload")
    if payload.get("success") is False:
        raise RuntimeError(f"R2 list failed: {payload.get('errors') or payload}")
    result = payload.get("result") or []
    if not isinstance(result, list):
        raise RuntimeError("R2 list result was not a list")
    keys: list[str] = []
    for item in result:
        if isinstance(item, dict) and item.get("key"):
            keys.append(str(item["key"]))
    info = payload.get("result_info") or {}
    cursor = None
    if isinstance(info, dict) and info.get("is_truncated") and info.get("cursor"):
        cursor = str(info["cursor"])
    return keys, cursor


def rest_object_url(account_id: str, bucket: str, key: str) -> str:
    encoded = "/".join(quote(part, safe="") for part in key.split("/"))
    return (
        f"{API_BASE}/accounts/{quote(account_id, safe='')}"
        f"/r2/buckets/{quote(bucket, safe='')}/objects/{encoded}"
    )


def rest_list_url(account_id: str, bucket: str, prefix: str, cursor: str | None) -> str:
    params = {"prefix": prefix, "per_page": "1000"}
    if cursor:
        params["cursor"] = cursor
    return (
        f"{API_BASE}/accounts/{quote(account_id, safe='')}"
        f"/r2/buckets/{quote(bucket, safe='')}/objects?{urlencode(params)}"
    )


def wrangler_r2_get_command(bucket: str, key: str, dest: Path) -> list[str]:
    """Wrangler 4 object path is {bucket}/{key}. --remote skips empty local state."""
    return [
        "npx",
        "wrangler",
        "r2",
        "object",
        "get",
        f"{bucket}/{key}",
        "--file",
        str(dest),
        "--remote",
    ]


def _default_rest_fetch(url: str, headers: dict[str, str]) -> tuple[int, bytes]:
    request = urllib.request.Request(url, headers=headers, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read()


def _s3_missing(exc: Exception) -> bool:
    response = getattr(exc, "response", None)
    if not isinstance(response, dict):
        return False
    code = str(response.get("Error", {}).get("Code", ""))
    status = response.get("ResponseMetadata", {}).get("HTTPStatusCode")
    return code in {"NoSuchKey", "404", "NotFound"} or status == 404


class R2ArchiveClient:
    """Read a day of market archives.

    The archiver writes `{prefix}/manifest.json`. List is the backfill for days
    from before that index existed, and for keys lost when two writers update
    the manifest at once. S3 is used when R2 access-key secrets are set.
    Otherwise list uses the Cloudflare REST API and download uses wrangler.
    """

    def __init__(
        self,
        bucket: str,
        env: Mapping[str, str] | None = None,
        rest_fetch: RestFetch | None = None,
        s3_client: object | None = None,
        run: RunCommand | None = None,
    ):
        self.bucket = bucket
        source = env if env is not None else os.environ
        self._account = source.get("CLOUDFLARE_ACCOUNT_ID", "").strip()
        self._token = source.get("CLOUDFLARE_API_TOKEN", "").strip()
        access = source.get("R2_ACCESS_KEY_ID", "").strip()
        secret = source.get("R2_SECRET_ACCESS_KEY", "").strip()
        self._rest_fetch = rest_fetch or _default_rest_fetch
        self._run = run or subprocess.run
        if s3_client is not None:
            self._s3 = s3_client
            self.mode = "s3"
        elif access or secret:
            if not (access and secret and self._account):
                raise RuntimeError(
                    "R2 S3 sync needs R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and CLOUDFLARE_ACCOUNT_ID"
                )
            import boto3

            self._s3 = boto3.client(
                "s3",
                endpoint_url=f"https://{self._account}.r2.cloudflarestorage.com",
                aws_access_key_id=access,
                aws_secret_access_key=secret,
                region_name="auto",
            )
            self.mode = "s3"
        elif self._token and self._account:
            self._s3 = None
            self.mode = "cloudflare-rest"
        else:
            raise RuntimeError(
                "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID, "
                "or R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and CLOUDFLARE_ACCOUNT_ID"
            )
        print(f"R2 client: {self.mode} (manifest + list)")

    def keys_for_prefix(self, prefix: str) -> list[str]:
        return merge_archive_keys(self._manifest_keys(prefix), self._list_keys(prefix))

    def download(self, key: str, dest: Path) -> None:
        dest.parent.mkdir(parents=True, exist_ok=True)
        if self._s3 is not None:
            self._s3.download_file(self.bucket, key, str(dest))
            return
        command = wrangler_r2_get_command(self.bucket, key, dest)
        proc = self._run(command, capture_output=True, text=True, check=False)
        if proc.returncode != 0:
            raise RuntimeError(f"failed to download {key}: {proc.stderr or proc.stdout}")

    def _manifest_keys(self, prefix: str) -> list[str]:
        key = manifest_object_key(prefix)
        if self._s3 is not None:
            try:
                obj = self._s3.get_object(Bucket=self.bucket, Key=key)
            except Exception as exc:
                if _s3_missing(exc):
                    return []
                raise
            body = obj["Body"].read()
            return parse_manifest_body(body)
        status, body = self._rest_get(key)
        if status == 404:
            return []
        if status != 200:
            raise RuntimeError(f"failed to read manifest {key}: HTTP {status} {body[:300]!r}")
        return parse_manifest_body(body)

    def _list_keys(self, prefix: str) -> list[str]:
        if self._s3 is not None:
            return self._s3_list(prefix)
        return self._rest_list(prefix)

    def _s3_list(self, prefix: str) -> list[str]:
        keys: list[str] = []
        token: str | None = None
        for _ in range(MAX_LIST_PAGES):
            kwargs: dict = {"Bucket": self.bucket, "Prefix": prefix, "MaxKeys": 1000}
            if token:
                kwargs["ContinuationToken"] = token
            page = self._s3.list_objects_v2(**kwargs)
            for item in page.get("Contents") or []:
                item_key = item.get("Key")
                if item_key:
                    keys.append(str(item_key))
            if not page.get("IsTruncated"):
                return keys
            token = page.get("NextContinuationToken")
            if not token:
                return keys
        raise RuntimeError(f"R2 list for {prefix} exceeded {MAX_LIST_PAGES} pages")

    def _rest_list(self, prefix: str) -> list[str]:
        keys: list[str] = []
        cursor: str | None = None
        for _ in range(MAX_LIST_PAGES):
            url = rest_list_url(self._account, self.bucket, prefix, cursor)
            status, body = self._rest_fetch(url, self._rest_headers())
            if status != 200:
                raise RuntimeError(f"R2 list failed: HTTP {status} {body[:300]!r}")
            page_keys, cursor = parse_rest_list_body(body)
            keys.extend(page_keys)
            if not cursor:
                return keys
        raise RuntimeError(f"R2 list for {prefix} exceeded {MAX_LIST_PAGES} pages")

    def _rest_get(self, key: str) -> tuple[int, bytes]:
        return self._rest_fetch(rest_object_url(self._account, self.bucket, key), self._rest_headers())

    def _rest_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self._token}"}


def iter_dates(since: str, until: str | None) -> list[str]:
    """Inclusive YYYY-MM-DD range."""
    start = date.fromisoformat(since)
    end = date.fromisoformat(until or since)
    if end < start:
        start, end = end, start
    days: list[str] = []
    cur = start
    while cur <= end:
        days.append(cur.isoformat())
        cur += timedelta(days=1)
    return days


def sync_prefix(client: R2ArchiveClient, prefix: str, cache_dir: Path, verbose: bool = False) -> list[Path]:
    keys = client.keys_for_prefix(prefix)
    downloaded: list[Path] = []
    for key in keys:
        dest = cache_dir / key
        if dest.exists():
            if verbose:
                print(f"skip existing {key}")
            continue
        if verbose:
            print(f"download {key}")
        client.download(key, dest)
        downloaded.append(dest)
    return downloaded


def sync_markets_range(
    bucket: str,
    source: str,
    since: str,
    until: str | None,
    cache_dir: Path,
    verbose: bool = False,
) -> list[Path]:
    """Sync `{source}/markets/{day}/...` for each day in [since, until]."""
    client = R2ArchiveClient(bucket)
    downloaded: list[Path] = []
    for day in iter_dates(since, until):
        prefix = f"{source}/markets/{day}"
        downloaded.extend(sync_prefix(client, prefix, cache_dir, verbose=verbose))
    return downloaded


def iter_jsonl_gz(path: Path):
    opener = gzip.open if path.suffix == ".gz" or path.name.endswith(".jsonl.gz") else open
    mode = "rt" if path.suffix == ".gz" or path.name.endswith(".jsonl.gz") else "r"
    with opener(path, mode, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                yield json.loads(line)
