"""Mechanical safety and integrity review for derived synthetic source rows."""

from __future__ import annotations

import argparse
import ipaddress
import json
import re
from pathlib import Path
from typing import Any

from compiler import canonical_json, certification_hash, normalized_hash, raw_hash, record_hash, validate_source_record

EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,}|localhost)\b", re.IGNORECASE)
IPV4 = re.compile(r"(?<![\w:])(?:\d{1,3}\.){3}\d{1,3}(?![\w:])")
IPV6 = re.compile(r"(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{0,4}:){2,7}[0-9A-Fa-f]{0,4}(?![0-9A-Fa-f:])")
TIME_FRAGMENT = re.compile(r"\d{1,2}:\d{2}:\d{2}(?:\.\d+)?")
TENANT_DOMAIN = re.compile(r"\b([a-z0-9-]+)\.onmicrosoft\.com\b", re.IGNORECASE)
TENANT_ID = re.compile(r"(?i)\btenant(?:id)?\b[^\n\r]{0,40}\b([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\b")
SECRET_PATTERNS = (
    re.compile(r"(?i)(?:api[_-]?key|client[_-]?secret|password|passwd|authorization|access[_-]?token|refresh[_-]?token)\s*[:=]\s*[^\s,}\]]{8,}"),
    re.compile(r"(?i)\bbearer\s+[a-z0-9._~+/-]{16,}={0,2}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?i)\bAccountKey=[A-Za-z0-9+/=]{20,}"),
)
DOCUMENTATION_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "192.0.2.0/24", "198.51.100.0/24", "203.0.113.0/24", "2001:db8::/32"
))
FICTIONAL_DOMAINS = ("example.com", "example.net", "example.org", "example", "test", "invalid", "localhost")


def _strings(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            yield from _strings(item)
    elif isinstance(value, dict):
        for key, item in value.items():
            yield key
            yield from _strings(item)


def _fictional_domain(domain: str) -> bool:
    value = domain.lower().rstrip(".")
    return value in FICTIONAL_DOMAINS or any(value.endswith("." + suffix) for suffix in FICTIONAL_DOMAINS)


def mechanical_findings(record: dict[str, Any]) -> list[str]:
    findings = []
    documents = record.get("documents")
    rendered = canonical_json(documents)
    for pattern in SECRET_PATTERNS:
        if pattern.search(rendered):
            findings.append("possible secret material")
    for text in _strings(documents):
        for match in EMAIL.finditer(text):
            domain = match.group(1).lower()
            if not _fictional_domain(domain):
                findings.append(f"non-fictional email domain: {domain}")
        for match in TENANT_DOMAIN.finditer(text):
            if match.group(1).lower() not in ("example", "synthetic", "test"):
                findings.append(f"non-fictional Microsoft tenant domain: {match.group(0).lower()}")
        if TENANT_ID.search(text):
            findings.append("possible real tenant identifier")
        for token in set(IPV4.findall(text) + IPV6.findall(text)):
            if TIME_FRAGMENT.fullmatch(token):
                continue
            try:
                address = ipaddress.ip_address(token)
            except ValueError:
                findings.append(f"invalid IP-shaped value: {token}")
                continue
            if not (address.is_private or address.is_loopback or address.is_link_local or any(address in network for network in DOCUMENTATION_NETWORKS)):
                findings.append(f"non-documentation routable IP: {token}")
    if record.get("provenance", {}).get("rawHash") != raw_hash(record):
        findings.append("rawHash does not match source documents")
    if record.get("provenance", {}).get("normalizedHash") != normalized_hash(record):
        findings.append("normalizedHash does not match normalized content")
    if record.get("recordHash") != record_hash(record):
        findings.append("recordHash does not match canonical record content")
    if record.get("certificationHash") != certification_hash(record):
        findings.append("certificationHash does not bind review and lineage")
    return sorted(set(findings))


def validate_file(source: Path) -> dict[str, Any]:
    failures = []
    count = 0
    for line_number, line in enumerate(source.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        count += 1
        try:
            record = validate_source_record(json.loads(line), require_approved=True)
            findings = mechanical_findings(record)
            if findings:
                failures.append({"line": line_number, "sampleId": record["sampleId"], "findings": findings})
        except (ValueError, json.JSONDecodeError) as error:
            failures.append({"line": line_number, "findings": [str(error)]})
    return {"records": count, "approved": count - len(failures), "failures": failures}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("dataset", type=Path)
    args = parser.parse_args()
    report = validate_file(args.dataset)
    print(json.dumps(report, indent=2))
    raise SystemExit(1 if report["failures"] else 0)


if __name__ == "__main__":
    main()
