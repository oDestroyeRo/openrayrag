//! Bounded signed archive validation and a same-volume replacement with rollback.
//! This does not invoke the plugin's privileged macOS installer.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
#[cfg(target_os = "macos")]
use std::{
    fs,
    io::{self, Cursor, Read},
    path::{Component, Path},
    process::Command,
};
pub(crate) const MAX_ARCHIVE: usize = 128 * 1024 * 1024;
#[cfg(target_os = "macos")]
const MAX_EXPANDED: u64 = 512 * 1024 * 1024;
#[cfg(target_os = "macos")]
const ERROR:&str="Automatic installation did not finish. Use the release download or the retained recovery bundle if needed.";
pub(crate) fn verify(
    bytes: &[u8],
    signature: &str,
    key: &str,
    version: &str,
) -> Result<(), String> {
    if bytes.is_empty() || bytes.len() > MAX_ARCHIVE || signature.len() > 4096 {
        return Err("Update signature is invalid.".into());
    }
    let check = || -> Option<()> {
        let key = String::from_utf8(STANDARD.decode(key).ok()?).ok()?;
        let sig = String::from_utf8(STANDARD.decode(signature).ok()?).ok()?;
        let sig = Signature::decode(&sig).ok()?;
        PublicKey::decode(&key)
            .ok()?
            .verify(bytes, &sig, true)
            .ok()?;
        let mut versions = sig
            .trusted_comment()
            .split('\t')
            .filter_map(|s| s.strip_prefix("version:"));
        if versions.next()? != version || versions.next().is_some() {
            return None;
        }
        Some(())
    };
    check().ok_or_else(|| "Update signature or signed version is invalid.".into())
}
#[cfg(target_os = "macos")]
fn safe_path(p: &Path) -> bool {
    p.components().all(|c| matches!(c, Component::Normal(_)))
        && p.components()
            .next()
            .is_some_and(|c| c.as_os_str() == "Rayrag Companion.app")
}
#[cfg(target_os = "macos")]
fn extract(bytes: &[u8], directory: &Path) -> io::Result<()> {
    // Check raw records before tar internally buffers GNU/PAX metadata. Such
    // metadata counts toward the same byte/entry limits as ordinary members.
    let mut raw =
        tar::Archive::new(flate2::read::GzDecoder::new(Cursor::new(bytes)).take(MAX_EXPANDED + 1));
    let mut raw_total = 0u64;
    for (index, entry) in raw.entries()?.raw(true).enumerate() {
        let entry = entry?;
        raw_total = raw_total.checked_add(entry.size()).ok_or_else(invalid)?;
        if index >= 10_000 || raw_total > MAX_EXPANDED {
            return Err(invalid());
        }
    }
    let decoder = flate2::read::GzDecoder::new(Cursor::new(bytes)).take(MAX_EXPANDED + 1);
    let mut archive = tar::Archive::new(decoder);
    let mut total = 0u64;
    let mut count = 0usize;
    let mut paths = std::collections::HashSet::new();
    for entry in archive.entries()? {
        let mut entry = entry?;
        let kind = entry.header().entry_type();
        count += 1;
        total = total.checked_add(entry.size()).ok_or_else(invalid)?;
        let path = entry.path()?.into_owned();
        let mode = entry.header().mode()?;
        let destination = directory.join(&path);
        // Existing regular files are never overwritten, including Unicode/case
        // aliases resolved by the destination filesystem. ASCII case aliases
        // of directory members are rejected before changing their metadata.
        let alias_key = path.to_string_lossy().to_lowercase();
        if count > 10_000
            || total > MAX_EXPANDED
            || !paths.insert(alias_key)
            || !safe_path(&path)
            || mode & 0o7022 != 0
            || kind.is_dir() && mode & 0o100 == 0
            || kind.is_file() && destination.try_exists()?
            || !(kind.is_file() || kind.is_dir())
        {
            return Err(invalid());
        }
        if !entry.unpack_in(directory)? {
            return Err(invalid());
        }
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn invalid() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "Invalid update bundle")
}
#[cfg(target_os = "macos")]
fn launchable(bundle: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    let directories = [
        bundle.to_path_buf(),
        bundle.join("Contents"),
        bundle.join("Contents/MacOS"),
    ];
    if directories.iter().any(|p| {
        fs::symlink_metadata(p).map_or(true, |m| !m.is_dir() || m.permissions().mode() & 0o100 == 0)
    }) {
        return false;
    }
    fs::symlink_metadata(bundle.join("Contents/MacOS/rayrag-companion"))
        .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o100 != 0)
}
#[cfg(target_os = "macos")]
fn newer_than_installed(bundle: &Path, version: &str) -> bool {
    let Some(installed) = plist::Value::from_file(bundle.join("Contents/Info.plist"))
        .ok()
        .and_then(|v| {
            v.as_dictionary()?
                .get("CFBundleShortVersionString")?
                .as_string()
                .map(str::to_owned)
        })
    else {
        return false;
    };
    let (Ok(candidate), Ok(current)) = (
        semver::Version::parse(version),
        semver::Version::parse(&installed),
    ) else {
        return false;
    };
    bundle_matches(bundle, &installed) && candidate > current
}
#[cfg(target_os = "macos")]
fn bundle_matches(bundle: &Path, version: &str) -> bool {
    let Ok(v) = plist::Value::from_file(bundle.join("Contents/Info.plist")) else {
        return false;
    };
    let Some(d) = v.as_dictionary() else {
        return false;
    };
    d.get("CFBundleIdentifier").and_then(|v| v.as_string()) == Some("com.rayrag.companion")
        && d.get("CFBundleShortVersionString")
            .and_then(|v| v.as_string())
            == Some(version)
        && d.get("CFBundleVersion").and_then(|v| v.as_string()) == Some(version)
        && d.get("CFBundleExecutable").and_then(|v| v.as_string()) == Some("rayrag-companion")
}
/// Atomic exchange leaves the canonical .app launchable at every crash boundary.
#[cfg(target_os = "macos")]
fn exchange(current: &Path, staged: &Path) -> io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let a = CString::new(current.as_os_str().as_bytes()).map_err(|_| invalid())?;
    let b = CString::new(staged.as_os_str().as_bytes()).map_err(|_| invalid())?;
    // SAFETY: two owned same-volume paths; RENAME_SWAP atomically exchanges their entries.
    if unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            a.as_ptr(),
            libc::AT_FDCWD,
            b.as_ptr(),
            libc::RENAME_SWAP,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn sync_tree(path: &Path) -> io::Result<()> {
    if fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(invalid());
    }
    if path.is_dir() {
        for entry in fs::read_dir(path)? {
            sync_tree(&entry?.path())?;
        }
    }
    fs::File::open(path)?.sync_all()
}
#[cfg(target_os = "macos")]
fn replace(
    current: &Path,
    staged: &Path,
    swap: impl Fn(&Path, &Path) -> io::Result<()>,
    sync: impl Fn() -> io::Result<()>,
) -> io::Result<()> {
    swap(current, staged)?;
    if let Err(error) = sync() {
        let _ = swap(current, staged);
        let _ = sync();
        return Err(error);
    }
    Ok(())
}
#[cfg(target_os = "macos")]
fn lock_cache(cache: &Path) -> io::Result<crate::login::local_store::FileLock> {
    use std::os::unix::fs::OpenOptionsExt;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(cache.join("transaction.lock"))?;
    crate::login::local_store::verify_private(&lock, false)?;
    // Keep acquired operation ownership through the entire install transaction.
    crate::login::local_store::FileLock::acquire(lock)
}
pub(crate) fn install(bytes: &[u8], version: &str) -> Result<(), String> {
    #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
    {
        let _ = (bytes, version);
        Err("Use the release download to update this platform.".into())
    }
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        let perform = || -> io::Result<()> {
            let executable = tauri::utils::platform::current_exe()?;
            let current = executable
                .ancestors()
                .find(|p| p.extension().is_some_and(|x| x == "app"))
                .ok_or_else(invalid)?;
            if current
                .file_name()
                .map_or(true, |n| n != "Rayrag Companion.app")
                || fs::symlink_metadata(current)?.file_type().is_symlink()
            {
                return Err(invalid());
            }
            let parent = current.parent().ok_or_else(invalid)?;
            let cache = parent.join(".rayrag-update-recovery");
            let created = match fs::create_dir(&cache) {
                Ok(()) => true,
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => false,
                Err(e) => return Err(e),
            };
            use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
            let cache_fd = fs::OpenOptions::new()
                .read(true)
                .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW)
                .open(&cache)?;
            if created {
                cache_fd.set_permissions(fs::Permissions::from_mode(0o700))?;
                crate::login::local_store::access_list::clear(&cache_fd)?;
            }
            crate::login::local_store::verify_private(&cache_fd, true)?;
            fs::File::open(parent)?.sync_all()?;
            let _transaction_lock = lock_cache(&cache)?;
            // Another instance may have replaced the on-disk app since this
            // process started. Compare under the interprocess lock, not only
            // against the running binary's build-time version.
            if !newer_than_installed(current, version) {
                return Err(invalid());
            }
            // A private staging directory in this parent is also the writeability probe.
            // No admin prompt or alternative elevated path exists.
            let staging = tempfile::Builder::new()
                .prefix(".rayrag-update-")
                .tempdir_in(&cache)?;
            let dir = fs::File::open(staging.path())?;
            crate::login::local_store::access_list::clear(&dir).map_err(|_| invalid())?;
            extract(bytes, staging.path())?;
            let staged = staging.path().join("Rayrag Companion.app");
            if !bundle_matches(&staged, version) || !launchable(&staged) {
                return Err(invalid());
            }
            let result = Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict"])
                .arg(&staged)
                .output()?;
            if !result.status.success() {
                return Err(invalid());
            }
            // Verify ARM64 Mach-O, not just the feed's platform label.
            let mut binary = [0; 8];
            fs::File::open(staged.join("Contents/MacOS/rayrag-companion"))?
                .read_exact(&mut binary)?;
            if binary[..4] != [0xcf, 0xfa, 0xed, 0xfe]
                || u32::from_le_bytes(binary[4..8].try_into().map_err(|_| invalid())?) != 0x0100000c
            {
                return Err(invalid());
            }
            sync_tree(staging.path())?;
            // At most one previous bundle is retained. The fixed private cache
            // is unrelated to credential/settings storage and never follows links.
            let backup = cache.join("previous.app");
            if let Ok(meta) = fs::symlink_metadata(&backup) {
                if !meta.is_dir() || meta.file_type().is_symlink() {
                    return Err(invalid());
                }
                fs::remove_dir_all(&backup)?;
            }
            fs::rename(&staged, &backup)?;
            sync_tree(&cache)?;
            replace(current, &backup, exchange, || {
                cache_fd.sync_all()?;
                fs::File::open(parent)?.sync_all()
            })
        };
        perform().map_err(|_| ERROR.into())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(target_os = "macos")]
    #[test]
    fn atomic_replacement_and_sync_failure_preserve_a_launchable_app() {
        let t = tempfile::tempdir().unwrap();
        let old = t.path().join("old");
        let new = t.path().join("new");
        fs::create_dir(&old).unwrap();
        fs::write(old.join("working"), b"old").unwrap();
        fs::create_dir(&new).unwrap();
        fs::write(new.join("working"), b"new").unwrap();
        assert!(replace(
            &old,
            &new,
            |_, _| Err(io::Error::other("injected swap failure")),
            || Ok(())
        )
        .is_err());
        assert_eq!(fs::read(old.join("working")).unwrap(), b"old");
        assert!(replace(&old, &new, exchange, || Err(io::Error::other(
            "injected sync failure"
        )))
        .is_err());
        assert_eq!(fs::read(old.join("working")).unwrap(), b"old");
        replace(&old, &new, exchange, || Ok(())).unwrap();
        assert_eq!(fs::read(old.join("working")).unwrap(), b"new");
        assert_eq!(fs::read(new.join("working")).unwrap(), b"old");
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn private_transaction_lock_excludes_another_process_owner() {
        let t = tempfile::tempdir().unwrap();
        let first = lock_cache(t.path()).unwrap();
        assert!(lock_cache(t.path()).is_err());
        drop(first);
        assert!(lock_cache(t.path()).is_ok());
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn cache_lock_release_is_owned_by_the_acquiring_process() {
        use crate::login::local_store::InheritedLock;
        use std::os::fd::AsRawFd;
        let t = tempfile::tempdir().unwrap();
        let mut first = lock_cache(t.path()).unwrap();
        let mut retained = InheritedLock::new(first.as_raw_fd());
        let mut dropping = InheritedLock::dropping_copy(&mut first);
        let active_exclusion = lock_cache(t.path()).err().map(|e| e.kind());
        // Failed acquisitions cannot release the still-active owning operation.
        let repeated_exclusion = lock_cache(t.path()).err().map(|e| e.kind());
        drop(first);
        let reopened = lock_cache(t.path());
        let completion_releases = reopened.is_ok();
        let next_operation_excludes = lock_cache(t.path()).err().map(|e| e.kind());
        drop(reopened);
        let next_completion_releases = lock_cache(t.path()).is_ok();
        let dropping_status = dropping.finish();
        let retained_status = retained.finish();
        assert_eq!(dropping_status, 0);
        assert_eq!(retained_status, 0);
        assert_eq!(active_exclusion, Some(io::ErrorKind::WouldBlock));
        assert_eq!(repeated_exclusion, Some(io::ErrorKind::WouldBlock));
        assert!(completion_releases);
        assert_eq!(next_operation_excludes, Some(io::ErrorKind::WouldBlock));
        assert!(next_completion_releases);
    }

    #[cfg(target_os = "macos")]
    fn archive(entries: &[(&str, u32, tar::EntryType)]) -> Vec<u8> {
        let mut tar = tar::Builder::new(Vec::new());
        for (path, mode, kind) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_mode(*mode);
            header.set_entry_type(*kind);
            header.set_size(1);
            header.set_cksum();
            tar.append_data(&mut header, *path, &b"x"[..]).unwrap();
        }
        let data = tar.into_inner().unwrap();
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        std::io::Write::write_all(&mut gz, &data).unwrap();
        gz.finish().unwrap()
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn archive_aliases_links_and_unsafe_modes_reject() {
        use tar::EntryType;
        for entries in [
            vec![
                ("Rayrag Companion.app/same", 0o644, EntryType::Regular),
                ("Rayrag Companion.app/SAME", 0o644, EntryType::Regular),
            ],
            vec![
                ("Rayrag Companion.app/file", 0o644, EntryType::Regular),
                ("Rayrag Companion.app/file", 0o644, EntryType::Regular),
            ],
            vec![("Rayrag Companion.app/file", 0o777, EntryType::Regular)],
            vec![("Rayrag Companion.app/file", 0o4755, EntryType::Regular)],
            vec![("Rayrag Companion.app/link", 0o644, EntryType::Symlink)],
        ] {
            let t = tempfile::tempdir().unwrap();
            assert!(extract(&archive(&entries), t.path()).is_err());
        }
        let t = tempfile::tempdir().unwrap();
        assert!(extract(
            &archive(&[("Rayrag Companion.app/good", 0o755, EntryType::Regular)]),
            t.path()
        )
        .is_ok());
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn advertised_version_must_match_both_bundle_version_fields() {
        let t = tempfile::tempdir().unwrap();
        fs::create_dir(t.path().join("Contents")).unwrap();
        let mut d = plist::Dictionary::new();
        for (k, v) in [
            ("CFBundleIdentifier", "com.rayrag.companion"),
            ("CFBundleShortVersionString", "0.2.9"),
            ("CFBundleVersion", "0.2.1"),
            ("CFBundleExecutable", "rayrag-companion"),
        ] {
            d.insert(k.into(), v.into());
        }
        plist::Value::Dictionary(d.clone())
            .to_file_xml(t.path().join("Contents/Info.plist"))
            .unwrap();
        assert!(!bundle_matches(t.path(), "0.2.9"));
        d.insert("CFBundleVersion".into(), "0.2.9".into());
        plist::Value::Dictionary(d)
            .to_file_xml(t.path().join("Contents/Info.plist"))
            .unwrap();
        assert!(bundle_matches(t.path(), "0.2.9"));
        assert!(!newer_than_installed(t.path(), "0.2.8"));
        assert!(!newer_than_installed(t.path(), "0.2.9"));
        assert!(newer_than_installed(t.path(), "0.2.10"));
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn bundle_requires_owner_executable_binary_and_searchable_directories() {
        use std::os::unix::fs::PermissionsExt;
        let t = tempfile::tempdir().unwrap();
        let bundle = t.path().join("Rayrag Companion.app");
        fs::create_dir_all(bundle.join("Contents/MacOS")).unwrap();
        let binary = bundle.join("Contents/MacOS/rayrag-companion");
        fs::write(&binary, b"synthetic ARM64").unwrap();
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(!launchable(&bundle));
        fs::set_permissions(&binary, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(launchable(&bundle));
        fs::set_permissions(
            bundle.join("Contents/MacOS"),
            fs::Permissions::from_mode(0o644),
        )
        .unwrap();
        assert!(!launchable(&bundle));
        fs::set_permissions(
            bundle.join("Contents/MacOS"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        assert!(launchable(&bundle));
    }
    #[test]
    fn signature_and_authenticated_version_bind_the_payload() {
        let f: serde_json::Value =
            serde_json::from_str(include_str!("update-signature-test.json")).unwrap();
        let b = STANDARD
            .decode(f["payloadBase64"].as_str().unwrap())
            .unwrap();
        let sig = f["signature"].as_str().unwrap();
        let key = f["publicKey"].as_str().unwrap();
        verify(&b, sig, key, "0.2.27").unwrap();
        assert!(verify(b"archive", "bad", "bad", "0.2.1").is_err());
        assert!(verify(&b, sig, key, "0.2.28").is_err());
        let mut altered = b;
        altered[0] ^= 1;
        assert!(verify(&altered, sig, key, "0.2.27").is_err());
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn paths_and_invalid_signatures_reject() {
        assert!(!safe_path(Path::new("../Rayrag Companion.app")));
        assert!(!safe_path(Path::new("Rayrag Companion.app/../../escape")));
        assert!(!safe_path(Path::new("Other.app/file")));
        assert!(verify(b"archive", "bad", "bad", "0.2.1").is_err());
        assert!(extract(b"not gzip", Path::new("/unused")).is_err());
    }
}
