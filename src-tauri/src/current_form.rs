//! Settings-only persistence. Credentials and running intent are not part of this schema.
pub(crate) use crate::current_form_logic::FormDocument;
use crate::{
    current_form_logic::{encode, matches_encoded, parse, validate_revision, ERROR, MAX_BYTES},
    login::local_store as file,
};
use std::{
    fs::File,
    io::{Read, Write},
    path::PathBuf,
};
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
    let bytes = encode(d)?;
    let dir = file::LocalLoginStore::settings(app_data)
        .open_directory(true)
        .map_err(|_| ERROR)?
        .ok_or(ERROR)?;
    if let Some(old) = read(&dir)? {
        validate_revision(d.checked_revision()?, &old, &bytes)?;
    }
    file::private_file(&dir, "current.json").map_err(|_| ERROR)?;
    file::remove_private_file(&dir, ".current.tmp").map_err(|_| ERROR)?;
    let result = (|| -> Result<(), String> {
        let mut temp = file::create_private_file(&dir, ".current.tmp").map_err(|_| ERROR)?;
        file::verify_private(&temp, false).map_err(|_| ERROR)?;
        temp.write_all(&bytes).map_err(|_| ERROR)?;
        temp.sync_all().map_err(|_| ERROR)?;
        file::rename_at(&dir, ".current.tmp", "current.json").map_err(|_| ERROR)?;
        file::sync_directory(&dir).map_err(|_| ERROR)?;
        let restored = read(&dir)?.ok_or(ERROR)?;
        if !matches_encoded(&restored, &bytes)? {
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
    fn repeated_saves_confirm_profile_and_reject_conflicting_equal_revision() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().canonicalize().unwrap();
        let mut form = document(1);
        form.selected_profile_id = Some("synthetic-profile".into());
        save(path.clone(), &form).unwrap();
        save(path.clone(), &form).unwrap();
        form.selected_profile_id = Some("changed-profile".into());
        assert!(save(path.clone(), &form).is_err());
        assert_eq!(
            load(path.clone())
                .unwrap()
                .unwrap()
                .selected_profile_id
                .as_deref(),
            Some("synthetic-profile")
        );
        form.revision = 2;
        save(path.clone(), &form).unwrap();
        let restored = load(path).unwrap().unwrap();
        assert_eq!(restored.revision, 2);
        assert_eq!(restored.selected_profile_id, form.selected_profile_id);
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
}
