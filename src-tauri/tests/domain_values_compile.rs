//! Compile the real owners in their nested module graph, proving construction cannot bypass admission.
use std::{
    path::{Path, PathBuf},
    process::{Command, Output},
};

fn dependency(directory: &Path, name: &str, expected: u64) -> PathBuf {
    let prefix = format!("lib{name}-");
    let fingerprints = directory.parent().unwrap().join(".fingerprint");
    std::fs::read_dir(directory)
        .unwrap()
        .filter_map(Result::ok)
        .find(|entry| {
            let file = entry.file_name();
            let Some(hash) = file
                .to_str()
                .and_then(|file| file.strip_prefix(&prefix))
                .and_then(|file| file.strip_suffix(".rlib"))
            else {
                return false;
            };
            // Cargo can retain host, target, and feature variants in the same deps directory.
            // Select the artifact linked by this test, not the last artifact written by a check.
            [name.to_owned(), name.replace('_', "-")]
                .iter()
                .any(|package| {
                    let stamp = fingerprints.join(format!("{package}-{hash}/lib-{name}"));
                    std::fs::read_to_string(stamp)
                        .ok()
                        .and_then(|hex| u64::from_str_radix(hex.trim(), 16).ok())
                        .is_some_and(|value| value.swap_bytes() == expected)
                })
        })
        .unwrap_or_else(|| panic!("missing dependency {name} linked by this test"))
        .path()
}

fn linked_dependencies(executable: &Path, deps: &Path) -> Vec<(&'static str, PathBuf)> {
    let hash = executable
        .file_stem()
        .unwrap()
        .to_str()
        .unwrap()
        .rsplit_once('-')
        .unwrap()
        .1;
    let descriptor = deps.parent().unwrap().join(format!(
        ".fingerprint/{}-{hash}/test-integration-test-domain_values_compile.json",
        env!("CARGO_PKG_NAME")
    ));
    let linked: serde_json::Value =
        serde_json::from_slice(&std::fs::read(descriptor).unwrap()).unwrap();
    [
        "frunk",
        "frunk_core",
        "serde",
        "serde_json",
        "semver",
        "base64",
        "minisign_verify",
        "plist",
    ]
    .into_iter()
    .map(|name| {
        let expected = linked["deps"]
            .as_array()
            .unwrap()
            .iter()
            .find(|dep| dep[1].as_str() == Some(name))
            .unwrap_or_else(|| panic!("missing Cargo fingerprint for {name}"))[3]
            .as_u64()
            .unwrap();
        (name, dependency(deps, name, expected))
    })
    .collect()
}

fn compile(source: &str, dir: &Path, deps: &Path, linked: &[(&str, PathBuf)]) -> Output {
    let fixture = dir.join("probe.rs");
    let owner = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/shared/domain_values.rs");
    let updater = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/update/updater_logic.rs");
    let installer =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("src/update/update_install_logic.rs");
    std::fs::write(
        &fixture,
        format!("#![allow(dead_code)]\nmod shared {{ #[path = {owner:?}] pub(crate) mod domain_values; }}\nmod update {{ #[path = {updater:?}] pub(crate) mod updater_logic; #[path = {installer:?}] pub(crate) mod update_install_logic; }}\n{source}\n"),
    )
    .unwrap();
    let mut command = Command::new(std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into()));
    command
        .arg("--edition=2021")
        .arg("--emit=metadata")
        .arg("--crate-name=domain_probe")
        .arg("--out-dir")
        .arg(dir)
        .arg("-L")
        .arg(format!("dependency={}", deps.display()))
        .arg(fixture);
    for (name, path) in linked {
        command
            .arg("--extern")
            .arg(format!("{name}={}", path.display()));
    }
    command.output().unwrap()
}

#[test]
fn domain_values_reject_private_unchecked_serde_and_generic_construction() {
    let dir = tempfile::tempdir().unwrap();
    let executable = std::env::current_exe().unwrap();
    let deps = executable.parent().unwrap();
    let linked = linked_dependencies(&executable, deps);
    let control = compile("fn main() { let slot = shared::domain_values::CharacterSlot::try_from(2_u8).unwrap(); assert_eq!(slot.index(), 2); let _: frunk::HList![u8] = frunk::hlist![0_u8]; fn serde_available<T: serde::Serialize>() {} serde_available::<u8>(); let version = update::updater_logic::StableUpdateVersion::try_from(\"1.2.3\".to_owned()).unwrap(); assert_eq!(version.as_str(), \"1.2.3\"); let _: fn(Vec<u8>, update::updater_logic::CandidateAsset, &str) -> Result<update::update_install_logic::VerifiedArchive, String> = update::update_install_logic::VerifiedArchive::new; }", dir.path(), deps, &linked);
    assert!(
        control.status.success(),
        "positive control failed: {}",
        String::from_utf8_lossy(&control.stderr)
    );
    for (source, expected) in [
        ("fn main() { let _ = shared::domain_values::CharacterSlot(3); }", "E0603"),
        ("fn main() { let slot = shared::domain_values::CharacterSlot::try_from(0_u8).unwrap(); let _ = slot.0; }", "E0616"),
        ("fn main() { let mut slot = shared::domain_values::CharacterSlot::try_from(0_u8).unwrap(); slot.0 = 3; }", "E0616"),
        ("fn main() { let _: shared::domain_values::FormRevision = shared::domain_values::CharacterSlot::try_from(0_u8).unwrap(); }", "E0308"),
        ("fn main() { let _: shared::domain_values::CharacterSlot = 3_u8.into(); }", "E0277"),
        ("fn main() { let _: shared::domain_values::CharacterSlot = frunk::from_generic(frunk::hlist![3_u8]); }", "E0277"),
        ("fn main() { fn decode<T: serde::de::DeserializeOwned>() {} decode::<shared::domain_values::CharacterSlot>(); }", "E0277"),
        ("fn main() { let _: shared::domain_values::ItemId = shared::domain_values::BagId::try_from(1_i64).unwrap(); }", "E0308"),
        ("fn main() { let _: shared::domain_values::SessionId<'_> = shared::domain_values::ConnectionId::try_from(\"identity\").unwrap(); }", "E0308"),
        ("fn main() { let _: shared::domain_values::RecoveryTimeoutSeconds = shared::domain_values::Percentage::try_from(1_u8).unwrap(); }", "E0308"),
        ("fn main() { fn encode<T: serde::Serialize>() {} encode::<shared::domain_values::OwnedPassword>(); }", "E0277"),
        ("fn main() { let _ = update::updater_logic::StableUpdateVersion { text: \"invalid\".into(), parsed: semver::Version::new(0, 0, 0) }; }", "E0451"),
        ("fn main() { let version = update::updater_logic::StableUpdateVersion::try_from(\"1.2.3\".to_owned()).unwrap(); let _ = update::updater_logic::CandidateAsset { version, platform: update::updater_logic::Platform { url: \"wrong\".into(), signature: \"wrong\".into() } }; }", "E0451"),
        ("fn main() { let version = update::updater_logic::StableUpdateVersion::try_from(\"1.2.3\".to_owned()).unwrap(); let _ = update::update_install_logic::VerifiedArchive { bytes: std::sync::Arc::new(vec![0]), version }; }", "E0451"),
        ("fn main() { fn decode<T: serde::de::DeserializeOwned>() {} decode::<update::update_install_logic::VerifiedArchive>(); }", "E0277"),
        ("fn main() { let version = update::updater_logic::StableUpdateVersion::try_from(\"1.2.3\".to_owned()).unwrap(); let _: update::update_install_logic::VerifiedArchive = frunk::from_generic(frunk::hlist![std::sync::Arc::new(vec![0_u8]), version]); }", "E0277"),
    ] {
        let result = compile(source, dir.path(), deps, &linked);
        let errors = String::from_utf8_lossy(&result.stderr);
        assert!(!result.status.success() && errors.contains(expected), "expected {expected}: {errors}");
        assert!(!errors.contains("E0432") && !errors.contains("E0433") && !errors.contains("E0463"), "dependency failure is not domain proof: {errors}");
    }
}
