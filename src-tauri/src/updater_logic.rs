//! Signed-update feed and stable-version policy, without networking.
use serde::Deserialize;
use std::collections::BTreeMap;

pub(crate) const MAX_METADATA: usize = 64_000;

#[derive(Deserialize)]
struct Feed {
    version: String,
    platforms: BTreeMap<String, Platform>,
}
#[derive(Deserialize)]
pub(crate) struct Platform {
    pub url: String,
    pub signature: String,
}
pub(crate) fn version(v: &str) -> Option<semver::Version> {
    let n = semver::Version::parse(v).ok()?;
    if !n.pre.is_empty() || !n.build.is_empty() || n.to_string() != v {
        return None;
    }
    Some(n)
}
pub(crate) fn parse_feed(
    bytes: &[u8],
    current: &str,
) -> Result<Option<(String, Platform)>, String> {
    if bytes.len() > MAX_METADATA {
        return Err("Update metadata is too large.".into());
    }
    let f: Feed = serde_json::from_slice(bytes).map_err(|_| "Update metadata is invalid.")?;
    let v = version(&f.version).ok_or("Update version is unsupported.")?;
    let c = semver::Version::parse(current).map_err(|_| "Installed version is unavailable.")?;
    if v <= c {
        return Ok(None);
    }
    let p = f
        .platforms
        .into_iter()
        .find(|(k, _)| k == "darwin-aarch64")
        .map(|(_, v)| v)
        .ok_or("No Apple Silicon update is available.")?;
    let expected=format!("https://github.com/oDestroyeRo/openrayrag/releases/download/v{}/Rayrag_Companion_{}_aarch64.app.tar.gz",f.version,f.version);
    if p.url != expected || p.signature.len() > 4096 {
        return Err("Update download metadata is invalid.".into());
    }
    Ok(Some((f.version, p)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::update_install_logic as update_install;
    fn feed(version: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": version,
            "platforms": {"darwin-aarch64": {
                "url": format!("https://github.com/oDestroyeRo/openrayrag/releases/download/v{version}/Rayrag_Companion_{version}_aarch64.app.tar.gz"),
                "signature": "test"
            }}
        }))
        .unwrap()
    }

    #[test]
    fn stable_newer_fixed_immutable_assets_only() {
        let url="https://github.com/oDestroyeRo/openrayrag/releases/download/v0.2.9/Rayrag_Companion_0.2.9_aarch64.app.tar.gz";
        let mut f = serde_json::json!({"version":"0.2.9","platforms":{"darwin-aarch64":{"url":url,"signature":"test"}}});
        assert!(parse_feed(&serde_json::to_vec(&f).unwrap(), "0.1.0")
            .unwrap()
            .is_some());
        assert!(parse_feed(&serde_json::to_vec(&f).unwrap(), "0.2.9")
            .unwrap()
            .is_none());
        f["platforms"]["darwin-aarch64"]["url"] = "https://evil.test/app".into();
        assert!(parse_feed(&serde_json::to_vec(&f).unwrap(), "0.1.0").is_err());
        for v in [
            "0.2.10-beta",
            "0.2.10+other",
            "v0.2.10",
            "01.2.10",
            "1.02.10",
            "1.2.010",
            "1.2",
            " 1.2.10",
            "1.2.10 ",
        ] {
            assert!(version(v).is_none());
        }
        for v in ["0.2.10", "0.3.0", "1.0.0", "12.30.100"] {
            assert!(version(v).is_some());
            let metadata = feed(v);
            assert_eq!(parse_feed(&metadata, "0.2.9").unwrap().unwrap().0, v);
            assert!(parse_feed(&metadata, v).unwrap().is_none());
            assert!(parse_feed(&metadata, "13.0.0").unwrap().is_none());
        }
    }
    #[test]
    fn semver_feed_still_requires_exact_archive_and_bounded_signature() {
        let mut metadata: serde_json::Value = serde_json::from_slice(&feed("1.2.3")).unwrap();
        let expected = metadata["platforms"]["darwin-aarch64"]["url"]
            .as_str()
            .unwrap()
            .to_owned();
        for url in [
            expected.replace("v1.2.3/", "v1.2.2/"),
            expected.replace("Companion_1.2.3_", "Companion_1.2.2_"),
            format!("{expected}?download=1"),
            expected.replace("aarch64", "x64"),
            expected.replace("https://", "http://"),
        ] {
            metadata["platforms"]["darwin-aarch64"]["url"] = url.into();
            assert!(parse_feed(&serde_json::to_vec(&metadata).unwrap(), "0.2.63").is_err());
        }
        metadata["platforms"]["darwin-aarch64"]["url"] = expected.into();
        metadata["platforms"]["darwin-aarch64"]["signature"] = "x".repeat(4097).into();
        assert!(parse_feed(&serde_json::to_vec(&metadata).unwrap(), "0.2.63").is_err());
        metadata["platforms"] = serde_json::json!({});
        assert!(parse_feed(&serde_json::to_vec(&metadata).unwrap(), "0.2.63").is_err());
    }
    #[test]
    fn feed_version_cannot_override_authenticated_archive_version() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let signed: serde_json::Value =
            serde_json::from_str(include_str!("update-signature-test.json")).unwrap();
        let payload = STANDARD
            .decode(signed["payloadBase64"].as_str().unwrap())
            .unwrap();
        let public_key = signed["publicKey"].as_str().unwrap();
        for advertised in ["0.2.27", "1.0.0"] {
            let mut metadata: serde_json::Value =
                serde_json::from_slice(&feed(advertised)).unwrap();
            metadata["platforms"]["darwin-aarch64"]["signature"] = signed["signature"].clone();
            let (v, platform) = parse_feed(&serde_json::to_vec(&metadata).unwrap(), "0.1.0")
                .unwrap()
                .unwrap();
            assert_eq!(
                update_install::verify(&payload, &platform.signature, public_key, &v).is_ok(),
                advertised == "0.2.27"
            );
            assert!(update_install::verify(&payload, &platform.signature, "invalid", &v).is_err());
        }
    }
}
