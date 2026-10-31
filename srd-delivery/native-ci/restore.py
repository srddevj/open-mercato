#!/usr/bin/env python3
"""Restore exact recorded app bytes from pinned public template plus overlays.

No package code, scaffold CLI, lifecycle script, migration or database is run.
"""
import argparse
import base64
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import tarfile
import urllib.request

HERE = Path(__file__).resolve().parent
CHECKOUT = HERE.parent.parent.resolve()


def safe_relative(name):
    path = PurePosixPath(name)
    if path.is_absolute() or not path.parts or any(p in ("..", ".") for p in path.parts) or "\\" in name:
        raise ValueError("unsafe_manifest_path")
    return path


def write_file(destination, name, data, mode):
    path = destination.joinpath(*safe_relative(name).parts)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    path.chmod(mode)


def source_hash(destination, records):
    digest = hashlib.sha256()
    source = sorted((record for record in records if record["scope"] == "canonical-source"), key=lambda x: x["path"])
    for record in source:
        name = record["path"].encode("utf-8")
        data = destination.joinpath(*safe_relative(record["path"]).parts).read_bytes()
        digest.update(len(name).to_bytes(8, "big"))
        digest.update(name)
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest(), len(source)


def restore(destination, report_path, tarball_path=None):
    index = json.loads((HERE / "source-index.json").read_text())
    destination = destination.resolve()
    if destination.is_relative_to(CHECKOUT):
        raise ValueError("restore_destination_must_be_outside_checkout")
    if destination.exists() and any(destination.iterdir()):
        raise ValueError("restore_destination_must_be_empty")
    records = index["files"]
    names = [str(safe_relative(record["path"])) for record in records]
    if len(set(names)) != len(names):
        raise ValueError("duplicate_manifest_path")
    if tarball_path:
        archive = tarball_path.read_bytes()
    else:
        with urllib.request.urlopen(index["template"]["url"], timeout=60) as response:
            archive = response.read()
    integrity = "sha512-" + base64.b64encode(hashlib.sha512(archive).digest()).decode()
    if integrity != index["template"]["integrity"]:
        raise ValueError("template_integrity_mismatch")
    import io
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as package:
        members = {member.name: member for member in package.getmembers()}
        destination.mkdir(parents=True, exist_ok=True)
        for record in records:
            if record["origin"] == "overlay":
                overlay = HERE / "overlay" / record["path"]
                if overlay.is_symlink() or not overlay.is_file():
                    raise ValueError("invalid_overlay_file")
                data = overlay.read_bytes()
            elif record["origin"] == "template":
                member = members.get("package/template/" + record["path"])
                if member is None or not member.isfile():
                    raise ValueError("invalid_template_file")
                data = package.extractfile(member).read()
            else:
                raise ValueError("unsupported_manifest_origin")
            if len(data) != record["size"] or hashlib.sha256(data).hexdigest() != record["sha256"]:
                raise ValueError("file_integrity_mismatch:" + record["path"])
            write_file(destination, record["path"], data, record["mode"])
    revision, count = source_hash(destination, records)
    if revision != index["sourceRevision"] or count != index["sourceFileCount"]:
        raise ValueError("canonical_source_revision_mismatch")
    verified = 0
    for record in records:
        data = destination.joinpath(*safe_relative(record["path"]).parts).read_bytes()
        if hashlib.sha256(data).hexdigest() != record["sha256"]:
            raise ValueError("restored_file_mismatch")
        verified += 1
    # Support is not part of the canonical app revision. Each supporting byte is
    # separately recorded and copied beside, never into, the restored app tree.
    for record in index.get("support", []):
        name = str(safe_relative(record["path"]))
        source = HERE / "support" / name
        if source.is_symlink() or not source.is_file():
            raise ValueError("invalid_support_file")
        data = source.read_bytes()
        if len(data) != record["size"] or hashlib.sha256(data).hexdigest() != record["sha256"]:
            raise ValueError("support_integrity_mismatch:" + name)
        target = destination.parent / name
        if target.exists():
            raise ValueError("support_target_exists:" + name)
        write_file(destination.parent, name, data, record["mode"])
    result = {
        "kind": "exact-canonical-app-restoration", "status": "restored-byte-identical",
        "sourceRevision": revision, "sourceFilesVerified": count,
        "runtimeAssetFilesVerified": verified - count, "totalAppFilesVerified": verified,
        "templateIntegrityVerified": True,
        "templateFileCount": sum(r["origin"] == "template" for r in records),
        "overlayFileCount": sum(r["origin"] == "overlay" for r in records),
        "supportFilesVerified": len(index.get("support", [])),
        "scaffoldExecuted": False, "dependenciesInstalled": False,
        "databaseAccessed": False, "productionAccepted": False,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result))
    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--destination", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--tarball", type=Path)
    args = parser.parse_args()
    restore(args.destination, args.report, args.tarball)
