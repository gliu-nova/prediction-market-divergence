"""Unit tests for research R2 sync helpers."""

from __future__ import annotations

import json
from pathlib import Path

from lib.r2_sync import (
    R2ArchiveClient,
    iter_dates,
    merge_archive_keys,
    parse_manifest_body,
    parse_rest_list_body,
    rest_list_url,
    rest_object_url,
    sync_prefix,
    wrangler_r2_get_command,
)


def test_iter_dates_inclusive_range():
    assert iter_dates("2026-07-01", "2026-07-03") == [
        "2026-07-01",
        "2026-07-02",
        "2026-07-03",
    ]


def test_iter_dates_defaults_until_to_since():
    assert iter_dates("2026-07-09", None) == ["2026-07-09"]


def test_iter_dates_swaps_inverted_range():
    assert iter_dates("2026-07-03", "2026-07-01") == [
        "2026-07-01",
        "2026-07-02",
        "2026-07-03",
    ]


def test_merge_archive_keys_prefers_manifest_and_skips_index():
    assert merge_archive_keys(
        ["polymarket/markets/2026-10-08/12-20261008120000.jsonl.gz", "notes.txt"],
        [
            "polymarket/markets/2026-10-08/12-20261008120000.jsonl.gz",
            "polymarket/markets/2026-10-08/13-20261008133148.jsonl.gz",
            "polymarket/markets/2026-10-08/manifest.json",
        ],
    ) == [
        "polymarket/markets/2026-10-08/12-20261008120000.jsonl.gz",
        "polymarket/markets/2026-10-08/13-20261008133148.jsonl.gz",
    ]


def test_parse_manifest_and_rest_list_page():
    assert parse_manifest_body(b'{"keys":["a.jsonl.gz", 1]}') == ["a.jsonl.gz"]
    assert parse_manifest_body(b"not-json") == []
    keys, cursor = parse_rest_list_body(
        json.dumps(
            {
                "success": True,
                "result": [{"key": "a.jsonl.gz"}, {"key": "manifest.json"}],
                "result_info": {"is_truncated": True, "cursor": "next"},
            }
        ).encode()
    )
    assert keys == ["a.jsonl.gz", "manifest.json"]
    assert cursor == "next"
    _, done = parse_rest_list_body(b'{"success": true, "result": []}')
    assert done is None


def test_rest_urls_keep_key_slashes_in_the_path():
    assert rest_object_url("acct", "bucket", "polymarket/markets/2026-10-08/manifest.json").endswith(
        "/accounts/acct/r2/buckets/bucket/objects/polymarket/markets/2026-10-08/manifest.json"
    )
    listed = rest_list_url("acct", "bucket", "polymarket/markets/2026-10-08", None)
    assert "prefix=polymarket%2Fmarkets%2F2026-10-08" in listed
    assert "per_page=1000" in listed


def test_wrangler_get_uses_object_path_and_remote():
    command = wrangler_r2_get_command("prediction-market-divergence-history", "kalshi/markets/day/file.jsonl.gz", Path("/tmp/out.gz"))
    assert command == [
        "npx",
        "wrangler",
        "r2",
        "object",
        "get",
        "prediction-market-divergence-history/kalshi/markets/day/file.jsonl.gz",
        "--file",
        "/tmp/out.gz",
        "--remote",
    ]
    assert "list" not in command
    assert "--prefix" not in command
    assert "--json" not in command


class _Missing(Exception):
    def __init__(self):
        self.response = {"Error": {"Code": "NoSuchKey"}, "ResponseMetadata": {"HTTPStatusCode": 404}}


class _FakeS3:
    def __init__(self):
        self.downloaded: list[tuple[str, str, str]] = []

    def get_object(self, Bucket, Key):
        raise _Missing()

    def list_objects_v2(self, **kwargs):
        if kwargs.get("ContinuationToken") == "page-2":
            return {
                "Contents": [{"Key": "polymarket/markets/2026-10-08/14-20261008140000.jsonl.gz"}],
                "IsTruncated": False,
            }
        return {
            "Contents": [
                {"Key": "polymarket/markets/2026-10-08/13-20261008133148.jsonl.gz"},
                {"Key": "polymarket/markets/2026-10-08/manifest.json"},
            ],
            "IsTruncated": True,
            "NextContinuationToken": "page-2",
        }

    def download_file(self, bucket, key, dest):
        self.downloaded.append((bucket, key, dest))
        Path(dest).write_bytes(b"gzip")


def test_s3_client_unions_list_pages_when_manifest_is_missing():
    client = R2ArchiveClient("prediction-market-divergence-history", s3_client=_FakeS3())
    assert client.mode == "s3"
    keys = client.keys_for_prefix("polymarket/markets/2026-10-08")
    assert keys == [
        "polymarket/markets/2026-10-08/13-20261008133148.jsonl.gz",
        "polymarket/markets/2026-10-08/14-20261008140000.jsonl.gz",
    ]


class _ManifestS3(_FakeS3):
    def get_object(self, Bucket, Key):
        body = b'{"keys":["polymarket/markets/2026-10-08/12-20261008120000.jsonl.gz"]}'

        class _Body:
            def read(self):
                return body

        return {"Body": _Body()}


def test_s3_client_keeps_manifest_keys_missing_from_the_list():
    client = R2ArchiveClient("bucket", s3_client=_ManifestS3())
    keys = client.keys_for_prefix("polymarket/markets/2026-10-08")
    assert keys[0] == "polymarket/markets/2026-10-08/12-20261008120000.jsonl.gz"
    assert "polymarket/markets/2026-10-08/13-20261008133148.jsonl.gz" in keys


def test_rest_client_paginates_and_downloads_with_wrangler():
    from tempfile import TemporaryDirectory

    calls: list[str] = []

    def fetch(url: str, headers: dict[str, str]):
        calls.append(url)
        assert headers["Authorization"] == "Bearer token"
        if url.endswith("/manifest.json"):
            return 404, b""
        if "cursor=" not in url:
            body = json.dumps(
                {
                    "success": True,
                    "result": [{"key": "polymarket/markets/2026-10-08/13-20261008133148.jsonl.gz"}],
                    "result_info": {"is_truncated": True, "cursor": "next"},
                }
            ).encode()
            return 200, body
        body = json.dumps(
            {
                "success": True,
                "result": [{"key": "polymarket/markets/2026-10-08/14-20261008140000.jsonl.gz"}],
                "result_info": {"is_truncated": False},
            }
        ).encode()
        return 200, body

    commands: list[list[str]] = []

    def run(command, capture_output, text, check):
        commands.append(command)

        class _Proc:
            returncode = 0
            stderr = ""
            stdout = ""

        return _Proc()

    client = R2ArchiveClient(
        "prediction-market-divergence-history",
        env={"CLOUDFLARE_API_TOKEN": "token", "CLOUDFLARE_ACCOUNT_ID": "acct"},
        rest_fetch=fetch,
        run=run,
    )
    assert client.mode == "cloudflare-rest"
    with TemporaryDirectory() as directory:
        downloaded = sync_prefix(client, "polymarket/markets/2026-10-08", Path(directory))
    assert len(downloaded) == 2
    assert commands[0][5] == (
        "prediction-market-divergence-history/polymarket/markets/2026-10-08/13-20261008133148.jsonl.gz"
    )
    assert commands[0][-1] == "--remote"
    assert any(url.endswith("/manifest.json") for url in calls)
    assert any("cursor=next" in url for url in calls)


def test_partial_s3_credentials_fail_closed():
    try:
        R2ArchiveClient("bucket", env={"R2_ACCESS_KEY_ID": "id", "CLOUDFLARE_ACCOUNT_ID": "acct"})
    except RuntimeError as exc:
        assert "R2_SECRET_ACCESS_KEY" in str(exc)
    else:
        raise AssertionError("expected missing S3 secret to raise")
