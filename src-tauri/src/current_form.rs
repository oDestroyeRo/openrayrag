//! Settings-only persistence. Credentials and running intent are not part of this schema.
use crate::{automation::Settings, login::local_store as file};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    io::{Read, Write},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
};
const MAX_BYTES: u64 = 256_000;
const ERROR: &str = "Current settings could not be saved or restored. Updates will wait.";
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct FormDocument {
    pub version: u8,
    pub revision: u64,
    #[serde(deserialize_with = "required_profile_id")]
    pub selected_profile_id: Option<String>,
    pub settings: Settings,
}
fn required_profile_id<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Option::<String>::deserialize(d)
}
impl FormDocument {
    pub fn validate(&self) -> Result<(), String> {
        if self.version != 1
            || self.revision > 9_007_199_254_740_991
            || self.selected_profile_id.as_ref().is_some_and(|id| {
                id.is_empty()
                    || id.len() > 64
                    || !id
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
        {
            return Err(ERROR.into());
        }
        self.settings.validate_form().map_err(|_| ERROR.into())
    }
}
fn parse(bytes: &[u8]) -> Result<FormDocument, String> {
    if bytes.len() as u64 > MAX_BYTES {
        return Err(ERROR.into());
    }
    let mut value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| ERROR)?;
    // The only prior schema lacked revision/profile metadata. Unknown keys still reject.
    if value.get("version").and_then(|v| v.as_u64()) == Some(0) {
        let o = value.as_object_mut().ok_or(ERROR)?;
        if o.len() != 2 || !o.contains_key("settings") {
            return Err(ERROR.into());
        }
        o.insert("version".into(), 1.into());
        o.insert("revision".into(), 0.into());
        o.insert("selectedProfileId".into(), serde_json::Value::Null);
    }
    let d: FormDocument = serde_json::from_value(value).map_err(|_| ERROR)?;
    d.validate()?;
    Ok(d)
}
fn read(directory: &File) -> Result<Option<FormDocument>, String> {
    let Some(mut f) = file::private_file(directory, "current.json").map_err(|_| ERROR)? else {
        return Ok(None);
    };
    if f.metadata().map_err(|_| ERROR)?.len() > MAX_BYTES {
        return Err(ERROR.into());
    }
    let mut b = Vec::new();
    Read::by_ref(&mut f)
        .take(MAX_BYTES + 1)
        .read_to_end(&mut b)
        .map_err(|_| ERROR)?;
    parse(&b).map(Some)
}
pub(crate) fn load(app_data: PathBuf) -> Result<Option<FormDocument>, String> {
    let store = file::LocalLoginStore::settings(app_data);
    match store.open_directory(false).map_err(|_| ERROR)? {
        Some(dir) => read(&dir),
        None => Ok(None),
    }
}
pub(crate) fn save(app_data: PathBuf, d: &FormDocument) -> Result<(), String> {
    d.validate()?;
    let bytes = serde_json::to_vec(d).map_err(|_| ERROR)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(ERROR.into());
    }
    let dir = file::LocalLoginStore::settings(app_data)
        .open_directory(true)
        .map_err(|_| ERROR)?
        .ok_or(ERROR)?;
    if let Some(old) = read(&dir)? {
        if d.revision < old.revision
            || d.revision == old.revision && serde_json::to_vec(&old).map_err(|_| ERROR)? != bytes
        {
            return Err(ERROR.into());
        }
    }
    file::private_file(&dir, "current.json").map_err(|_| ERROR)?;
    file::remove_private_file(&dir, ".current.tmp").map_err(|_| ERROR)?;
    let result = (|| -> Result<(), String> {
        let mut temp = file::open_at(
            &dir,
            ".current.tmp",
            libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            0o600,
        )
        .map_err(|_| ERROR)?;
        temp.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| ERROR)?;
        file::access_list::clear(&temp).map_err(|_| ERROR)?;
        file::verify_private(&temp, false).map_err(|_| ERROR)?;
        temp.write_all(&bytes).map_err(|_| ERROR)?;
        temp.sync_all().map_err(|_| ERROR)?;
        file::rename_at(&dir, ".current.tmp", "current.json").map_err(|_| ERROR)?;
        dir.sync_all().map_err(|_| ERROR)?;
        let restored = read(&dir)?.ok_or(ERROR)?;
        if serde_json::to_vec(&restored).map_err(|_| ERROR)? != bytes {
            return Err(ERROR.into());
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = file::remove_private_file(&dir, ".current.tmp");
    }
    result
}
#[cfg(test)]
mod tests {
    use super::*;
    fn document(revision: u64) -> FormDocument {
        parse(format!(r#"{{"version":1,"revision":{revision},"selectedProfileId":null,"settings":{{"map":"","targets":[],"radius":12,"minHpPercent":45,"loot":true,"route_randomWalk":0,"route_step":10,"route_avoidWalls":true,"route_randomWalk_maxRouteTime":75,"attackRouteMaxPathDistance":20,"attackMaxRouteTime":4}}}}"#).as_bytes()).unwrap()
    }
    #[test]
    fn empty_form_is_not_playable_and_stale_writes_reject() {
        let d = document(3);
        assert!(d.settings.validate().is_err());
        let t = tempfile::tempdir().unwrap();
        let p = t.path().canonicalize().unwrap();
        save(p.clone(), &d).unwrap();
        assert!(save(p.clone(), &document(2)).is_err());
        assert_eq!(load(p).unwrap().unwrap().revision, 3);
    }
    #[test]
    fn document_excludes_credentials_and_intent() {
        let d = document(0);
        let mut v = serde_json::to_value(d).unwrap();
        for key in [
            "password",
            "username",
            "running",
            "runRequested",
            "refine",
            "previewToken",
            "refineReceipt",
            "refineConfirmation",
        ] {
            v[key] = true.into();
            assert!(parse(&serde_json::to_vec(&v).unwrap()).is_err());
            v.as_object_mut().unwrap().remove(key);
        }
    }
    #[test]
    fn bounded_corrupt_private_reads() {
        let t = tempfile::tempdir().unwrap();
        let p = t.path().canonicalize().unwrap();
        save(p.clone(), &document(0)).unwrap();
        std::fs::write(
            p.join("settings/current.json"),
            vec![b' '; MAX_BYTES as usize + 1],
        )
        .unwrap();
        assert!(load(p.clone()).is_err());
        assert!(save(p, &document(1)).is_err());
    }
    #[test]
    fn migration_has_no_running_intent() {
        let d = document(0);
        let v = serde_json::json!({"version":0,"settings":d.settings});
        let x = parse(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(x.version, 1);
        assert_eq!(x.revision, 0);
        assert!(x.selected_profile_id.is_none());
    }
}
