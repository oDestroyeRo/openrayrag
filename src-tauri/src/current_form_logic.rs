//! Settings document schema and persistence policy, without storage effects.
use crate::automation::Settings;
use serde::{Deserialize, Serialize};

pub(crate) const MAX_BYTES: u64 = 256_000;
pub(crate) const ERROR: &str =
    "Current settings could not be saved or restored. Updates will wait.";
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
pub(crate) fn parse(bytes: &[u8]) -> Result<FormDocument, String> {
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
pub(crate) fn encode(document: &FormDocument) -> Result<Vec<u8>, String> {
    document.validate()?;
    let bytes = serde_json::to_vec(document).map_err(|_| ERROR)?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(ERROR.into());
    }
    Ok(bytes)
}

pub(crate) fn validate_revision(
    incoming: &FormDocument,
    previous: &FormDocument,
    encoded: &[u8],
) -> Result<(), String> {
    if incoming.revision < previous.revision
        || incoming.revision == previous.revision && !matches_encoded(previous, encoded)?
    {
        return Err(ERROR.into());
    }
    Ok(())
}

pub(crate) fn matches_encoded(document: &FormDocument, encoded: &[u8]) -> Result<bool, String> {
    Ok(serde_json::to_vec(document).map_err(|_| ERROR)? == encoded)
}

pub(crate) fn same_form(a: &FormDocument, b: &FormDocument) -> bool {
    serde_json::to_vec(a).ok() == serde_json::to_vec(b).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn document(revision: u64) -> FormDocument {
        parse(format!(r#"{{"version":1,"revision":{revision},"selectedProfileId":null,"settings":{{"map":"","targets":[],"radius":12,"minHpPercent":45,"loot":true,"route_randomWalk":0,"route_step":10,"route_avoidWalls":true,"route_randomWalk_maxRouteTime":75,"attackRouteMaxPathDistance":20,"attackMaxRouteTime":4}}}}"#).as_bytes()).unwrap()
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
    fn migration_has_no_running_intent() {
        let d = document(0);
        let v = serde_json::json!({"version":0,"settings":d.settings});
        let x = parse(&serde_json::to_vec(&v).unwrap()).unwrap();
        assert_eq!(x.version, 1);
        assert_eq!(x.revision, 0);
        assert!(x.selected_profile_id.is_none());
    }
    #[test]
    fn revision_policy_accepts_replays_and_rejects_stale_or_conflicting_forms() {
        let previous = document(3);
        let replay = document(3);
        validate_revision(&replay, &previous, &encode(&replay).unwrap()).unwrap();
        let stale = document(2);
        assert!(validate_revision(&stale, &previous, &encode(&stale).unwrap()).is_err());
        let mut conflict = document(3);
        conflict.selected_profile_id = Some("another-profile".into());
        assert!(validate_revision(&conflict, &previous, &encode(&conflict).unwrap()).is_err());
        conflict.revision = 4;
        validate_revision(&conflict, &previous, &encode(&conflict).unwrap()).unwrap();
    }

    #[test]
    fn metadata_and_legacy_schema_fail_closed() {
        let value = serde_json::to_value(document(0)).unwrap();
        for key in ["revision", "selectedProfileId"] {
            let mut missing = value.clone();
            missing.as_object_mut().unwrap().remove(key);
            assert!(parse(&serde_json::to_vec(&missing).unwrap()).is_err());
        }
        for id in ["", "has spaces", "../profile"] {
            let mut invalid = value.clone();
            invalid["selectedProfileId"] = id.into();
            assert!(parse(&serde_json::to_vec(&invalid).unwrap()).is_err());
        }
        let mut legacy = serde_json::json!({"version":0,"settings":value["settings"]});
        legacy["revision"] = 0.into();
        assert!(parse(&serde_json::to_vec(&legacy).unwrap()).is_err());
        assert!(parse(&vec![b' '; MAX_BYTES as usize + 1]).is_err());
    }
}
