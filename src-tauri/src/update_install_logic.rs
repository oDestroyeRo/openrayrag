//! Signed archive and bundle metadata policy, without filesystem effects.
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};
#[cfg(any(target_os = "macos", test))]
use std::{
    io::Cursor,
    path::{Component, Path},
};

pub(crate) const MAX_ARCHIVE: usize = 128 * 1024 * 1024;

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
#[cfg(any(target_os = "macos", test))]
pub(crate) fn safe_path(p: &Path) -> bool {
    p.components().all(|c| matches!(c, Component::Normal(_)))
        && p.components()
            .next()
            .is_some_and(|c| c.as_os_str() == "Rayrag Companion.app")
}
#[cfg(any(target_os = "macos", test))]
pub(crate) fn parse_plist(bytes: &[u8]) -> Option<plist::Value> {
    plist::Value::from_reader(Cursor::new(bytes)).ok()
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn bundle_version(metadata: &plist::Value) -> Option<&str> {
    metadata
        .as_dictionary()?
        .get("CFBundleShortVersionString")?
        .as_string()
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn version_is_newer(candidate: &str, installed: &str) -> Option<bool> {
    let (Ok(candidate), Ok(installed)) = (
        semver::Version::parse(candidate),
        semver::Version::parse(installed),
    ) else {
        return None;
    };
    Some(candidate > installed)
}

#[cfg(any(target_os = "macos", test))]
pub(crate) fn bundle_matches(metadata: &plist::Value, version: &str) -> bool {
    let Some(d) = metadata.as_dictionary() else {
        return false;
    };
    d.get("CFBundleIdentifier").and_then(|v| v.as_string()) == Some("com.rayrag.companion")
        && d.get("CFBundleShortVersionString")
            .and_then(|v| v.as_string())
            == Some(version)
        && d.get("CFBundleVersion").and_then(|v| v.as_string()) == Some(version)
        && d.get("CFBundleExecutable").and_then(|v| v.as_string()) == Some("rayrag-companion")
}

#[cfg(test)]
mod tests {
    use super::*;
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

    fn metadata(version: &str) -> plist::Value {
        let mut dictionary = plist::Dictionary::new();
        for (key, value) in [
            ("CFBundleIdentifier", "com.rayrag.companion"),
            ("CFBundleShortVersionString", version),
            ("CFBundleVersion", version),
            ("CFBundleExecutable", "rayrag-companion"),
        ] {
            dictionary.insert(key.into(), value.into());
        }
        plist::Value::Dictionary(dictionary)
    }

    #[test]
    fn plist_policy_requires_both_versions_and_expected_bundle_identity() {
        let expected = metadata("1.2.3");
        for binary in [false, true] {
            let mut bytes = Vec::new();
            if binary {
                expected.to_writer_binary(&mut bytes).unwrap();
            } else {
                expected.to_writer_xml(&mut bytes).unwrap();
            }
            let parsed = parse_plist(&bytes).unwrap();
            assert_eq!(bundle_version(&parsed), Some("1.2.3"));
            assert!(bundle_matches(&parsed, "1.2.3"));
            assert!(!bundle_matches(&parsed, "1.2.4"));
        }
        for key in [
            "CFBundleIdentifier",
            "CFBundleVersion",
            "CFBundleExecutable",
        ] {
            let mut altered = expected.clone();
            altered
                .as_dictionary_mut()
                .unwrap()
                .insert(key.into(), "other".into());
            assert!(!bundle_matches(&altered, "1.2.3"));
        }
        assert!(parse_plist(b"corrupt").is_none());
        assert!(bundle_version(&plist::Value::Boolean(true)).is_none());
    }

    #[test]
    fn version_and_archive_paths_reject_rollback_and_escape() {
        assert_eq!(version_is_newer("0.2.10", "0.2.9"), Some(true));
        for candidate in ["0.2.8", "0.2.9"] {
            assert_eq!(version_is_newer(candidate, "0.2.9"), Some(false));
        }
        assert_eq!(version_is_newer("0.2.10", "invalid"), None);
        assert_eq!(version_is_newer("invalid", "0.2.9"), None);
        assert!(safe_path(Path::new(
            "Rayrag Companion.app/Contents/Info.plist"
        )));
        for path in [
            "../Rayrag Companion.app",
            "Rayrag Companion.app/../../escape",
            "Other.app/file",
            "/Rayrag Companion.app",
        ] {
            assert!(!safe_path(Path::new(path)));
        }
    }
}
