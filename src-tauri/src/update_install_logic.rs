//! Signed archive and bundle metadata policy, without filesystem effects.
use base64::{engine::general_purpose::STANDARD, Engine};
#[cfg(any(target_os = "macos", test))]
use frunk::{hlist_pat, prelude::IntoValidated};
use minisign_verify::{PublicKey, Signature};
#[cfg(any(target_os = "macos", test))]
use std::{
    io::Cursor,
    path::{Component, Path},
};

pub(crate) const MAX_ARCHIVE: usize = 128 * 1024 * 1024;

/// Owned verification capability: version and bytes must authenticate against
/// the key supplied by orchestration (the sole production caller uses the
/// embedded release key). Immutable sharing cannot replace the verified payload.
#[derive(Clone)]
pub(crate) struct VerifiedArchive {
    bytes: std::sync::Arc<Vec<u8>>,
    version: crate::updater_logic::StableUpdateVersion,
}
impl VerifiedArchive {
    pub(crate) fn new(
        bytes: Vec<u8>,
        asset: crate::updater_logic::CandidateAsset,
        key: &str,
    ) -> Result<Self, String> {
        verify(&bytes, asset.signature(), key, asset.version().as_str())?;
        Ok(Self {
            bytes: std::sync::Arc::new(bytes),
            version: asset.into_version(),
        })
    }
    pub(crate) fn bytes(&self) -> &[u8] {
        &self.bytes
    }
    pub(crate) fn version(&self) -> &str {
        self.version.as_str()
    }
}

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
    // Both independent parsers were already evaluated together. Preserve that
    // contract while retaining their typed success values for comparison.
    (semver::Version::parse(candidate).into_validated() + semver::Version::parse(installed))
        .into_result()
        .ok()
        .map(|hlist_pat!(candidate, installed)| candidate > installed)
}

#[cfg(any(target_os = "macos", test))]
#[derive(frunk::Generic)]
struct BundleMetadata<'a> {
    identifier: BundleIdentifier<'a>,
    short_version: &'a str,
    build_version: &'a str,
    executable: BundleExecutable<'a>,
}
#[cfg(any(target_os = "macos", test))]
#[derive(Debug)]
enum BundleIdentityError {
    Identifier,
    Executable,
}
#[cfg(any(target_os = "macos", test))]
struct BundleIdentifier<'a>(&'a str);
#[cfg(any(target_os = "macos", test))]
impl<'a> TryFrom<&'a str> for BundleIdentifier<'a> {
    type Error = BundleIdentityError;
    fn try_from(value: &'a str) -> Result<Self, Self::Error> {
        (value == "com.rayrag.companion")
            .then_some(Self(value))
            .ok_or(BundleIdentityError::Identifier)
    }
}
#[cfg(any(target_os = "macos", test))]
struct BundleExecutable<'a>(&'a str);
#[cfg(any(target_os = "macos", test))]
impl<'a> TryFrom<&'a str> for BundleExecutable<'a> {
    type Error = BundleIdentityError;
    fn try_from(value: &'a str) -> Result<Self, Self::Error> {
        (value == "rayrag-companion")
            .then_some(Self(value))
            .ok_or(BundleIdentityError::Executable)
    }
}
#[cfg(any(target_os = "macos", test))]
impl<'a> BundleMetadata<'a> {
    fn parse(value: &'a plist::Value) -> Option<Self> {
        let dictionary = value.as_dictionary()?;
        let text = |key: &'static str| {
            dictionary
                .get(key)
                .and_then(plist::Value::as_string)
                .ok_or(key)
        };
        // This product validates independent identity fields. Version strings
        // remain untrusted until `matches`; Generic cannot bypass that relation.
        (text("CFBundleIdentifier")
            .and_then(|value| BundleIdentifier::try_from(value).map_err(|_| "CFBundleIdentifier"))
            .into_validated()
            + text("CFBundleShortVersionString")
            + text("CFBundleVersion")
            + text("CFBundleExecutable").and_then(|value| {
                BundleExecutable::try_from(value).map_err(|_| "CFBundleExecutable")
            }))
        .into_result()
        .ok()
        .map(frunk::from_generic)
    }
    fn matches(&self, version: &str) -> bool {
        self.identifier.0 == "com.rayrag.companion"
            && self.short_version == version
            && self.build_version == version
            && self.executable.0 == "rayrag-companion"
    }
}
#[cfg(any(target_os = "macos", test))]
pub(crate) fn bundle_matches(metadata: &plist::Value, version: &str) -> bool {
    BundleMetadata::parse(metadata).is_some_and(|bundle| bundle.matches(version))
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

    #[test]
    fn verified_archive_retains_authenticated_bytes_and_exact_version_without_mutable_access() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("update-signature-test.json")).unwrap();
        let bytes = STANDARD
            .decode(fixture["payloadBase64"].as_str().unwrap())
            .unwrap();
        let asset = |version: &str| {
            let metadata = serde_json::json!({"version":version,"platforms":{"darwin-aarch64":{
                "url":format!("https://github.com/oDestroyeRo/openrayrag/releases/download/v{version}/Rayrag_Companion_{version}_aarch64.app.tar.gz"),
                "signature":fixture["signature"]}}});
            crate::updater_logic::parse_feed(&serde_json::to_vec(&metadata).unwrap(), "0.1.0")
                .unwrap()
                .unwrap()
        };
        let key = fixture["publicKey"].as_str().unwrap();
        let archive = VerifiedArchive::new(bytes.clone(), asset("0.2.27"), key).unwrap();
        let retained = archive.clone();
        assert_eq!(archive.bytes(), bytes);
        assert_eq!(archive.version(), "0.2.27");
        assert_eq!(archive.bytes().as_ptr(), retained.bytes().as_ptr());
        assert!(VerifiedArchive::new(bytes.clone(), asset("0.2.28"), key).is_err());
        let mut altered = bytes;
        altered[0] ^= 1;
        assert!(VerifiedArchive::new(altered, asset("0.2.27"), key).is_err());
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
    fn bundle_projection_requires_four_strings_but_keeps_unrelated_plist_fields() {
        let mut expected = metadata("1.2.3");
        expected
            .as_dictionary_mut()
            .unwrap()
            .insert("Extra".into(), true.into());
        assert!(bundle_matches(&expected, "1.2.3"));
        for key in [
            "CFBundleIdentifier",
            "CFBundleShortVersionString",
            "CFBundleVersion",
            "CFBundleExecutable",
        ] {
            let mut missing = expected.clone();
            missing.as_dictionary_mut().unwrap().remove(key);
            assert!(!bundle_matches(&missing, "1.2.3"));
            let mut wrong_type = expected.clone();
            wrong_type
                .as_dictionary_mut()
                .unwrap()
                .insert(key.into(), true.into());
            assert!(!bundle_matches(&wrong_type, "1.2.3"));
        }
        assert!(!bundle_matches(&plist::Value::Boolean(true), "1.2.3"));
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
