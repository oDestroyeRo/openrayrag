#!/usr/bin/env python3
"""Verify the GLib backport and optionally run its optimized iterator tests."""

import argparse
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


ARCHIVE_URL = "https://static.crates.io/crates/glib/glib-0.18.5.crate"
ARCHIVE_SHA256 = "233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5"
LOCAL_FILES = {".gitattributes", "PATCHES.md", "verify.py"}
SOURCE = "src/variant_iter.rs"
REPLACEMENTS = (
    (
        b"            let p: *mut libc::c_char = std::ptr::null_mut();",
        b"            let mut p: *mut libc::c_char = std::ptr::null_mut();",
    ),
    (b"                &p,", b"                &mut p,"),
)


def verify_source(crate, archive):
    if archive:
        data = archive.read_bytes()
    else:
        with urllib.request.urlopen(ARCHIVE_URL, timeout=60) as response:
            data = response.read()
    if hashlib.sha256(data).hexdigest() != ARCHIVE_SHA256:
        raise RuntimeError("published GLib archive checksum mismatch")

    expected = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as package:
        for member in package.getmembers():
            parts = PurePosixPath(member.name).parts
            if parts[0] != "glib-0.18.5" or ".." in parts:
                raise RuntimeError(f"unexpected archive path: {member.name}")
            if member.isdir():
                continue
            if not member.isfile() or len(parts) < 2:
                raise RuntimeError(f"unexpected archive member: {member.name}")
            name = PurePosixPath(*parts[1:]).as_posix()
            if name in expected:
                raise RuntimeError(f"duplicate archive member: {name}")
            expected[name] = package.extractfile(member).read()

    for old, new in REPLACEMENTS:
        if expected[SOURCE].count(old) != 1:
            raise RuntimeError("upstream fix does not match published source")
        expected[SOURCE] = expected[SOURCE].replace(old, new, 1)

    actual = set()
    for path in crate.rglob("*"):
        if path.is_symlink():
            raise RuntimeError(f"vendored symlink is not allowed: {path}")
        if path.is_file():
            actual.add(path.relative_to(crate).as_posix())
    if actual != set(expected) | LOCAL_FILES:
        raise RuntimeError(
            f"vendored file inventory differs: "
            f"{sorted(actual.symmetric_difference(set(expected) | LOCAL_FILES))}"
        )
    for name, content in expected.items():
        if (crate / name).read_bytes() != content:
            raise RuntimeError(f"vendored file differs from the backport: {name}")
    print(f"Verified {len(expected)} published files; only the two upstream lines changed.", flush=True)


def verify_resolution(crate, platform):
    root = crate.parent.parent
    metadata = json.loads(subprocess.check_output([
        "cargo", "metadata", "--locked", "--format-version", "1",
        "--manifest-path", str(root / "src-tauri/Cargo.toml"),
        "--filter-platform", platform,
    ]))
    nodes = {node["id"]: node for node in metadata["resolve"]["nodes"]}
    pending = [metadata["resolve"]["root"]]
    reachable = set()
    while pending:
        package = pending.pop()
        if package in reachable:
            continue
        reachable.add(package)
        pending.extend(nodes[package]["dependencies"])
    packages = [
        package for package in metadata["packages"]
        if package["name"] == "glib" and package["id"] in reachable
    ]
    if len(packages) != 1:
        raise RuntimeError(f"expected one GLib package in the {platform} dependency graph")
    package = packages[0]
    if (
        package["version"] != "0.18.5"
        or package["source"] is not None
        or Path(package["manifest_path"]).resolve() != crate / "Cargo.toml"
    ):
        raise RuntimeError(f"{platform} does not select the local GLib 0.18.5 backport")
    print(f"Locked {platform} dependency graph selects vendor/glib 0.18.5.", flush=True)


def test_iterators(crate):
    # A dependency cannot run its dev-tests through the app workspace. A scratch
    # copy keeps Cargo's test lockfile and build output out of the pristine vendor.
    with tempfile.TemporaryDirectory(prefix="rayrag-glib-tests-") as temporary:
        copy = Path(temporary) / "glib"
        shutil.copytree(crate, copy)
        shutil.copy2(crate.parent.parent / "src-tauri/Cargo.lock", copy / "Cargo.lock")
        probe = copy / "tests/rayrag_variant_str_iter.rs"
        probe.write_text('''use glib::variant::ToVariant;

#[test]
fn every_variant_str_iterator_output_path() {
    let variant = ["first", "middle", "last"].to_variant();
    assert_eq!(variant.array_iter_str().unwrap().next(), Some("first"));
    assert_eq!(variant.array_iter_str().unwrap().nth(1), Some("middle"));
    assert_eq!(variant.array_iter_str().unwrap().next_back(), Some("last"));
    assert_eq!(variant.array_iter_str().unwrap().nth_back(1), Some("middle"));
    assert_eq!(variant.array_iter_str().unwrap().last(), Some("last"));

    let mut mixed = variant.array_iter_str().unwrap();
    assert_eq!(mixed.next(), Some("first"));
    assert_eq!(mixed.next_back(), Some("last"));
    assert_eq!(mixed.next(), Some("middle"));
    assert_eq!(mixed.next_back(), None);
}
''')
        cargo = ["cargo", "test", "--manifest-path", str(copy / "Cargo.toml"), "--release"]
        subprocess.run(cargo + ["--lib", "test_variant_str_iter"], check=True)
        subprocess.run(cargo + ["--locked", "--test", "rayrag_variant_str_iter"], check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, help="reuse a downloaded crate archive")
    parser.add_argument("--platform", default="x86_64-unknown-linux-gnu")
    parser.add_argument("--test", action="store_true", help="run optimized iterator tests")
    args = parser.parse_args()
    crate = Path(__file__).resolve().parent
    verify_source(crate, args.archive)
    verify_resolution(crate, args.platform)
    if args.test:
        test_iterators(crate)


if __name__ == "__main__":
    main()
