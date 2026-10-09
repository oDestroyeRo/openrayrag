//! Update checkpoint schema and eligibility, with explicit time and no effects.
use crate::{
    session::login_logic::UpdateAccount,
    session::maintenance_logic::GameIdentity,
    settings::automation::{DeathRecoveryGuard, EscapeResumeGuard, Settings, SupplyResumeGuard},
    settings::current_form_logic::FormDocument,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::ffi::OsString;

pub(crate) const ERROR: &str = "Update continuation is unavailable. Sign in and start manually.";
pub(crate) const LAUNCH_PREFIX: &str = "--rayrag-update-resume=";
pub(crate) const STOPPED_FLAG: &str = "--rayrag-update-stopped";
pub(crate) const MAX_BYTES: u64 = 1_000_000;
pub(crate) const TTL_MS: u64 = 10 * 60 * 1000;
pub(crate) const SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContinuationBase {
    pub(crate) version: u8,
    pub(crate) field: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Continuation {
    pub(crate) version: u8,
    pub account: UpdateAccount,
    pub(crate) form: FormDocument,
    pub(crate) field: Value,
    pub runtime: Value,
    pub(crate) saved_account: bool,
}

/// Payload admitted after the destructive checkpoint read. Raw transport
/// reconstruction cannot manufacture this capability or mutate its retained data.
pub(crate) struct AdmittedContinuation(Continuation);
impl AdmittedContinuation {
    fn admit(payload: Continuation, at: u64) -> Result<Self, String> {
        validate_payload(&payload, at)?;
        Ok(Self(payload))
    }
    pub(crate) fn raw(&self) -> &Continuation {
        &self.0
    }
    pub(crate) fn into_wire(self) -> Continuation {
        self.0
    }
    pub(crate) fn with_saved_account(self, saved_account: bool) -> Self {
        Self(Continuation {
            saved_account,
            ..self.0
        })
    }
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct DiskCheckpoint {
    pub(crate) version: u8,
    pub(crate) target_version: String,
    pub(crate) created_at: u64,
    pub(crate) launch_token: Option<String>,
    pub(crate) continuation: Continuation,
}
fn invalid<T>() -> Result<T, String> {
    Err(ERROR.into())
}
pub(crate) fn request_id(value: &str) -> bool {
    crate::shared::domain_values::UpdateRequestId::try_from(value).is_ok()
}
fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
fn exact_with_live_guard(value: &Value, keys: &[&str]) -> bool {
    value.as_object().is_some_and(|object| {
        keys.iter().all(|key| object.contains_key(*key))
            && object
                .keys()
                .all(|key| keys.contains(&key.as_str()) || key == "liveSettingsGuard")
    })
}
fn validate_live_guard(value: &Value, at: u64, name: &str) -> Result<(), String> {
    if let Some(raw) = value
        .get("liveSettingsGuard")
        .filter(|guard| !guard.is_null())
    {
        let guard: crate::settings::automation::LiveSettingsGuard =
            serde_json::from_value(raw.clone()).map_err(|_| ERROR)?;
        guard.validate_at(at)?;
        if guard.character != name {
            return invalid();
        }
    }
    Ok(())
}
fn number(value: &Value) -> bool {
    value.as_u64().is_some_and(|n| n <= SAFE_INTEGER)
}
fn bounded(value: &Value, depth: usize) -> bool {
    if depth > 32 {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) => true,
        Value::Number(n) => n
            .as_f64()
            .is_some_and(|n| n.is_finite() && n.abs() <= SAFE_INTEGER as f64),
        Value::String(s) => s.len() <= 65_536 && !s.contains('\0'),
        Value::Array(a) => a.len() <= 1024 && a.iter().all(|v| bounded(v, depth + 1)),
        Value::Object(o) => {
            o.len() <= 256
                && o.iter().all(|(k, v)| {
                    let key = k.to_ascii_lowercase().replace(['_', '-'], "");
                    k.len() <= 64
                        && !["password", "credential", "packet"]
                            .iter()
                            .any(|name| key.contains(name))
                        && !matches!(
                            key.as_str(),
                            "password"
                                | "credentials"
                                | "cookie"
                                | "cookies"
                                | "authorization"
                                | "accesstoken"
                                | "refreshtoken"
                                | "authtoken"
                                | "sessiontoken"
                                | "packet"
                                | "packets"
                                | "rawpacket"
                                | "rawpackets"
                                | "packetbytes"
                        )
                        && bounded(v, depth + 1)
                })
        }
    }
}
fn validate_settings(value: &Value) -> Result<(), String> {
    let settings: Settings = serde_json::from_value(value.clone()).map_err(|_| ERROR)?;
    settings.validate().map_err(|_| ERROR.into())
}
pub(crate) fn validate_runtime(value: &Value, at: u64) -> Result<(), String> {
    if !exact_with_live_guard(
        value,
        &[
            "version",
            "frozenAt",
            "status",
            "settings",
            "macro",
            "partyHeal",
            "run",
        ],
    ) || value["version"] != 1
        || !number(&value["frozenAt"])
        || value["frozenAt"].as_u64().is_none_or(|n| n == 0 || n > at)
        || !value["status"].is_object()
        || value["status"]["connected"] != true
        || value["status"]["compatible"] != true
        || !value["status"]["runRequested"].is_boolean()
        || value["status"]
            .get("initialFieldEntryPending")
            .is_some_and(|pending| !pending.is_boolean())
        || character(value).is_none()
        || runtime_identity(value).is_none()
        || !bounded(value, 0)
        || serde_json::to_vec(value).map_err(|_| ERROR)?.len() > 750_000
    {
        return invalid();
    }
    if !value["settings"].is_null() {
        validate_settings(&value["settings"])?;
    }
    validate_live_guard(
        value,
        value["frozenAt"].as_u64().ok_or(ERROR)?,
        character(value).ok_or(ERROR)?,
    )?;
    let heal = &value["partyHeal"];
    if !exact(heal, &["version", "attempts", "confirmed", "cooldownUntil"])
        || heal["version"] != 1
        || !["attempts", "confirmed", "cooldownUntil"]
            .iter()
            .all(|k| number(&heal[*k]))
        || heal["confirmed"].as_u64() > heal["attempts"].as_u64()
    {
        return invalid();
    }
    let run = &value["run"];
    if !run.is_null()
        && (!exact(run, &["startedAt", "kills", "pickups", "deaths"])
            || run["startedAt"].as_u64() > value["frozenAt"].as_u64()
            || !["startedAt", "kills", "pickups", "deaths"]
                .iter()
                .all(|k| number(&run[*k])))
    {
        return invalid();
    }
    if !value["macro"].is_null() {
        let m = &value["macro"];
        if !exact(
            m,
            &[
                "version",
                "script",
                "selector",
                "sequence",
                "retainedField",
                "state",
                "reason",
                "generation",
                "nextId",
                "startedAt",
                "lastTime",
                "actionsIssued",
                "actionsCompleted",
                "spendReserved",
            ],
        ) || m["version"] != 1
            || !matches!(m["state"].as_str(), Some("running" | "monitoring"))
            || !m["selector"].is_object()
            || !m["reason"].as_str().is_some_and(|s| s.len() <= 800)
            || ![
                "generation",
                "nextId",
                "startedAt",
                "lastTime",
                "actionsIssued",
                "actionsCompleted",
                "spendReserved",
            ]
            .iter()
            .all(|k| number(&m[*k]))
            || m["actionsCompleted"] != m["actionsIssued"]
            || m["lastTime"].as_u64() < m["startedAt"].as_u64()
            || m["lastTime"].as_u64() > value["frozenAt"].as_u64()
        {
            return invalid();
        }
        let script = value["macro"].get("script").ok_or(ERROR)?;
        crate::game::control::request_script(
            "macro",
            &json!({"script":script,"settings":value["settings"]}),
        )
        .map_err(|_| ERROR)?;
    }
    if (value["status"]["runRequested"] == true || !value["macro"].is_null())
        && (value["settings"].is_null() || run.is_null())
    {
        return invalid();
    }
    Ok(())
}
fn experience_gains(value: &Value) -> bool {
    exact(value, &["baseGained", "jobGained"])
        && ["baseGained", "jobGained"].iter().all(|key| {
            value[*key].is_null()
                || value[*key]
                    .as_i64()
                    .is_some_and(|n| n.unsigned_abs() <= SAFE_INTEGER)
        })
}

fn field_experience(value: &Value, character: &Value) -> bool {
    if !exact(value, &["gains", "previous", "session"])
        || !experience_gains(&value["gains"])
        || !value["session"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 64)
    {
        return false;
    }
    let previous = &value["previous"];
    previous.is_null()
        || exact(
            previous,
            &["character", "run", "revision", "baseGained", "jobGained"],
        ) && previous["character"] == *character
            && number(&previous["run"])
            && previous["run"].as_u64().is_some_and(|run| run > 0)
            && number(&previous["revision"])
            && ["baseGained", "jobGained"].iter().all(|key| {
                previous[*key].is_null()
                    || previous[*key]
                        .as_i64()
                        .is_some_and(|n| n.unsigned_abs() <= SAFE_INTEGER)
            })
}

pub(crate) fn validate_field(value: &Value) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    let mut keys = vec![
        "version",
        "desired",
        "character",
        "session",
        "generation",
        "startedAt",
        "metricsSession",
        "previous",
        "totals",
        "escapeGuard",
        "supplyGuard",
        "deathGuard",
        "escapeOverflowUncertain",
        "supplyOverflow",
        "deathOverflow",
    ];
    if value.get("experience").is_some() {
        keys.push("experience");
        if !field_experience(&value["experience"], &value["character"]) {
            return invalid();
        }
    }
    if !exact_with_live_guard(value, &keys)
        || value["version"] != 1
        || !bounded(value, 0)
        || !["generation", "startedAt"]
            .iter()
            .all(|k| number(&value[*k]))
        || !["character", "session", "metricsSession"].iter().all(|k| {
            value[*k].as_str().is_some_and(|s| {
                !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
            })
        })
        || !["escapeOverflowUncertain", "supplyOverflow", "deathOverflow"]
            .iter()
            .all(|k| value[*k].is_boolean())
    {
        return invalid();
    }
    validate_settings(&value["desired"])?;
    validate_live_guard(
        value,
        SAFE_INTEGER,
        value["character"].as_str().ok_or(ERROR)?,
    )?;
    for k in ["previous", "totals"] {
        if !exact(&value[k], &["kills", "looted", "deaths", "attacks"])
            || !["kills", "looted", "deaths", "attacks"]
                .iter()
                .all(|n| number(&value[k][*n]))
        {
            return invalid();
        }
    }
    for key in ["supplyGuard", "deathGuard"] {
        let guard = &value[key];
        if guard.is_null() {
            continue;
        }
        if !exact(guard, &["session", "at", "guard"])
            || !guard["session"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 256)
            || !number(&guard["at"])
            || guard["guard"]["character"] != value["character"]
        {
            return invalid();
        }
        if key == "supplyGuard" {
            serde_json::from_value::<SupplyResumeGuard>(guard["guard"].clone())
                .map_err(|_| ERROR)?
                .validate()?;
        } else {
            serde_json::from_value::<DeathRecoveryGuard>(guard["guard"].clone())
                .map_err(|_| ERROR)?
                .validate()?;
        }
    }
    let escape = &value["escapeGuard"];
    if !escape.is_null() {
        let keys = if escape.get("recovery").is_some() {
            vec!["session", "cooldownUntil", "latched", "recovery"]
        } else {
            vec!["session", "cooldownUntil", "latched"]
        };
        if !exact(escape, &keys)
            || !escape["session"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 256)
            || !number(&escape["cooldownUntil"])
            || !escape["latched"].is_boolean()
        {
            return invalid();
        }
        let mut projected = json!({"cooldownSeconds":0,"latched":escape["latched"]});
        if let Some(recovery) = escape.get("recovery") {
            projected["recovery"] = recovery.clone();
        }
        serde_json::from_value::<EscapeResumeGuard>(projected)
            .map_err(|_| ERROR)?
            .validate()?;
    }
    Ok(())
}
pub(crate) struct RuntimeIdentity<'a> {
    session: crate::shared::domain_values::SessionId<'a>,
    connection: crate::shared::domain_values::ConnectionId<'a>,
}
impl RuntimeIdentity<'_> {
    pub(crate) fn matches(&self, observed: &GameIdentity) -> bool {
        self.session.as_str() == observed.session_id
            && self.connection.as_str() == observed.connection_id
    }
    #[cfg(test)]
    pub(crate) fn into_observation(self) -> GameIdentity {
        GameIdentity {
            session_id: self.session.as_str().to_owned(),
            connection_id: self.connection.as_str().to_owned(),
        }
    }
}

pub(crate) fn runtime_identity(runtime: &Value) -> Option<RuntimeIdentity<'_>> {
    let status = &runtime["status"];
    // Session and connection are distinct fields even with the same lexical rule.
    // Their sequential admission remains separate from raw bridge observations.
    let session =
        crate::shared::domain_values::SessionId::try_from(status["sessionId"].as_str()?).ok()?;
    let connection =
        crate::shared::domain_values::ConnectionId::try_from(status["connectionId"].as_str()?)
            .ok()?;
    Some(RuntimeIdentity {
        session,
        connection,
    })
}
pub(crate) fn character(runtime: &Value) -> Option<&str> {
    runtime
        .pointer("/status/player/name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
}
fn validate_payload(payload: &Continuation, at: u64) -> Result<(), String> {
    if payload.version != 1 {
        return invalid();
    }
    payload.account.validate()?;
    payload.form.validate()?;
    validate_field(&payload.field)?;
    validate_runtime(&payload.runtime, at)?;
    let name = character(&payload.runtime).ok_or(ERROR)?;
    if !payload.field.is_null() && payload.field["character"].as_str() != Some(name) {
        return invalid();
    }
    Ok(())
}
pub(crate) fn launch_token(
    args: &[OsString],
) -> Option<crate::shared::domain_values::UpdateRequestId<'_>> {
    let mut matching = args
        .iter()
        .skip(1)
        .filter_map(|arg| arg.to_str()?.strip_prefix(LAUNCH_PREFIX));
    let token = matching.next()?;
    if matching.next().is_some() {
        return None;
    }
    crate::shared::domain_values::UpdateRequestId::try_from(token).ok()
}
pub(crate) fn startup_stopped(args: &[OsString]) -> bool {
    args.iter()
        .skip(1)
        .any(|arg| arg.to_str() == Some(STOPPED_FLAG))
}
pub(crate) fn restart_arguments(args: &[OsString], stopped: bool) -> Vec<OsString> {
    let mut args: Vec<_> = args
        .iter()
        .filter(|arg| {
            !arg.to_str()
                .is_some_and(|s| s.starts_with(LAUNCH_PREFIX) || s == STOPPED_FLAG)
        })
        .cloned()
        .collect();
    if stopped {
        args.push(STOPPED_FLAG.into());
    }
    args
}
pub(crate) fn envelope(
    account: &UpdateAccount,
    form: &FormDocument,
    field: &Value,
    runtime: Option<&Value>,
) -> Result<Continuation, String> {
    // Form types deliberately remain settings-only. Clone by validated JSON so
    // no persistence-only metadata is introduced into their public contract.
    let form = serde_json::from_value(serde_json::to_value(form).map_err(|_| ERROR)?)
        .map_err(|_| ERROR)?;
    Ok(Continuation {
        version: 1,
        account: account.clone(),
        form,
        field: field.clone(),
        runtime: runtime.cloned().ok_or(ERROR)?,
        saved_account: false,
    })
}

pub(crate) fn encode_checkpoint(disk: &DiskCheckpoint, at: u64) -> Result<Vec<u8>, String> {
    validate_payload(&disk.continuation, at)?;
    let bytes = serde_json::to_vec(disk).map_err(|_| ERROR)?;
    if bytes.len() as u64 > MAX_BYTES {
        return invalid();
    }
    Ok(bytes)
}

/// Evaluate already-consumed bytes. Storage removal and account lookup belong
/// to the caller, so this policy cannot grant authority by reading stale data.
pub(crate) fn eligible_checkpoint(
    bytes: &[u8],
    args: &[OsString],
    compiled: &str,
    at: u64,
    runtime_at: u64,
) -> Option<AdmittedContinuation> {
    if bytes.len() as u64 > MAX_BYTES {
        return None;
    }
    let disk: DiskCheckpoint = serde_json::from_slice(bytes).ok()?;
    if startup_stopped(args) {
        return None;
    }
    let token = launch_token(args)?;
    if disk.version != 1
        || disk.target_version != compiled
        || disk
            .launch_token
            .as_deref()
            .and_then(|raw| crate::shared::domain_values::UpdateRequestId::try_from(raw).ok())
            != Some(token)
        || at < disk.created_at
        || at - disk.created_at > TTL_MS
    {
        return None;
    }
    AdmittedContinuation::admit(disk.continuation, runtime_at).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn launch_token_requires_one_checked_argument_after_the_executable() {
        let token = "0123456789abcdef0123456789abcdef";
        let flag = OsString::from(format!("{LAUNCH_PREFIX}{token}"));
        for args in [
            vec![],
            vec![flag.clone()],
            vec!["Companion".into()],
            vec!["Companion".into(), format!("{LAUNCH_PREFIX}invalid").into()],
            vec!["Companion".into(), flag.clone(), flag.clone()],
            vec![
                "Companion".into(),
                flag.clone(),
                format!("{LAUNCH_PREFIX}invalid").into(),
            ],
        ] {
            assert!(launch_token(&args).is_none());
        }
        let args = vec!["Companion".into(), "--unrelated".into(), flag];
        assert_eq!(
            launch_token(&args),
            Some(crate::shared::domain_values::UpdateRequestId::try_from(token).unwrap())
        );
    }

    #[cfg(unix)]
    #[test]
    fn launch_token_ignores_non_utf8_arguments() {
        use std::os::unix::ffi::OsStringExt;
        let token = "0123456789abcdef0123456789abcdef";
        let args = vec![
            "Companion".into(),
            OsString::from_vec(vec![0xff]),
            format!("{LAUNCH_PREFIX}{token}").into(),
        ];
        assert_eq!(
            launch_token(&args),
            Some(crate::shared::domain_values::UpdateRequestId::try_from(token).unwrap())
        );
    }

    #[test]
    fn run_experience_retains_signed_unknown_gains_and_character_ownership() {
        let mut experience = json!({"gains":{"baseGained":-21,"jobGained":null},"session":"first",
            "previous":{"character":"Test","run":1,"revision":2,"baseGained":-21,"jobGained":null}});
        assert!(field_experience(&experience, &json!("Test")));
        assert!(!field_experience(&experience, &json!("Other")));
        experience["previous"]["revision"] = json!(SAFE_INTEGER + 1);
        assert!(!field_experience(&experience, &json!("Test")));
        experience["previous"] = Value::Null;
        assert!(field_experience(&experience, &json!("Test")));
        experience["gains"]["baseGained"] = json!(-21.5);
        assert!(!field_experience(&experience, &json!("Test")));
    }

    #[test]
    fn restart_arguments_leave_inputs_unchanged_and_repeat_exactly() {
        let input = vec![
            OsString::from("Companion"),
            format!("{LAUNCH_PREFIX}0123456789abcdef0123456789abcdef").into(),
            STOPPED_FLAG.into(),
            "--unrelated-option".into(),
        ];
        let original = input.clone();
        for stopped in [false, true] {
            let mut expected: Vec<OsString> = vec!["Companion".into(), "--unrelated-option".into()];
            if stopped {
                expected.push(STOPPED_FLAG.into());
            }
            assert_eq!(restart_arguments(&input, stopped), expected);
            assert_eq!(restart_arguments(&input, stopped), expected);
            assert_eq!(input, original);
        }
    }

    fn runtime() -> Value {
        json!({"version":1,"frozenAt":1000,"status":{
            "sessionId":"synthetic-page","connectionId":"synthetic-socket",
            "connected":true,"compatible":true,"runRequested":false,
            "player":{"name":"Synthetic"}},"settings":null,"macro":null,
            "partyHeal":{"version":1,"attempts":2,"confirmed":1,"cooldownUntil":1100},
            "run":null})
    }
    #[test]
    fn validates_optional_initial_field_entry_telemetry() {
        let mut value = runtime();
        assert!(validate_runtime(&value, 1000).is_ok());
        value["status"]["initialFieldEntryPending"] = json!(true);
        assert!(validate_runtime(&value, 1000).is_ok());
        value["status"]["initialFieldEntryPending"] = json!(false);
        assert!(validate_runtime(&value, 1000).is_ok());
        value["status"]["initialFieldEntryPending"] = json!("pending");
        assert!(validate_runtime(&value, 1000).is_err());
    }
    #[test]
    fn carries_only_valid_same_character_live_settings_guards() {
        let mut value = runtime();
        value["liveSettingsGuard"] = json!({"version":1,"character":"Synthetic","items":[{"itemId":501,"minStock":3,"cooldownSeconds":60}],
            "hp":{"minStock":3,"cooldownSeconds":60},"sp":{"minStock":0,"cooldownSeconds":0},
            "cooldowns":[{"key":"item:501","at":1000}]});
        assert!(validate_runtime(&value, 1000).is_ok());
        value["liveSettingsGuard"]["cooldowns"][0]["at"] = json!(1001);
        assert!(validate_runtime(&value, 1000).is_err());
        value["liveSettingsGuard"]["cooldowns"][0]["at"] = json!(1000);
        value["liveSettingsGuard"]["character"] = json!("Other");
        assert!(validate_runtime(&value, 1000).is_err());
    }

    #[test]
    fn field_checkpoint_admits_experience_and_live_protection_together() {
        let settings = json!({"map":"prt_fild08","targets":[4000],"radius":8,"minHpPercent":45,"loot":true,
            "route_randomWalk":0,"route_step":10,"route_avoidWalls":true,
            "route_randomWalk_maxRouteTime":75,"attackRouteMaxPathDistance":20,"attackMaxRouteTime":4});
        let mut field = json!({"version":1,"desired":settings,"character":"Test","session":"first","generation":1,
            "startedAt":1000,"metricsSession":"first","previous":{"kills":0,"looted":0,"deaths":0,"attacks":0},
            "totals":{"kills":2,"looted":0,"deaths":0,"attacks":3},"escapeGuard":null,"supplyGuard":null,"deathGuard":null,
            "escapeOverflowUncertain":true,"supplyOverflow":false,"deathOverflow":false,
            "experience":{"gains":{"baseGained":-20,"jobGained":40},"session":"first",
                "previous":{"character":"Test","run":1,"revision":2,"baseGained":-20,"jobGained":40}},
            "liveSettingsGuard":{"version":1,"character":"Test","items":[{"itemId":501,"minStock":3,"cooldownSeconds":60}],
                "hp":{"minStock":3,"cooldownSeconds":60},"sp":{"minStock":0,"cooldownSeconds":0},
                "cooldowns":[{"key":"item:501","at":1000}]}});
        assert!(validate_field(&field).is_ok());
        field["experience"]["previous"]["character"] = json!("Other");
        assert!(validate_field(&field).is_err());
        field["experience"]["previous"]["character"] = json!("Test");
        field["liveSettingsGuard"]["character"] = json!("Other");
        assert!(validate_field(&field).is_err());
        field["liveSettingsGuard"]["character"] = json!("Test");
        field["unknown"] = json!(true);
        assert!(validate_field(&field).is_err());
    }

    fn checkpoint() -> DiskCheckpoint {
        serde_json::from_value(json!({
            "version":1,"targetVersion":"1.2.3","createdAt":1000,
            "launchToken":"0123456789abcdef0123456789abcdef",
            "continuation":{"version":1,"account":{
                "username":"synthetic-account","characterSlot":1,"mode":"botOnly"},
                "form":{"version":1,"revision":3,"selectedProfileId":null,"settings":{
                    "map":"","targets":[],"radius":12,"minHpPercent":45,"loot":true,
                    "route_randomWalk":0,"route_step":10,"route_avoidWalls":true,
                    "route_randomWalk_maxRouteTime":75,"attackRouteMaxPathDistance":20,
                    "attackMaxRouteTime":4}},"field":null,"runtime":runtime(),
                "savedAccount":true}
        }))
        .unwrap()
    }
    fn arguments() -> Vec<OsString> {
        vec![
            "Companion".into(),
            format!("{LAUNCH_PREFIX}0123456789abcdef0123456789abcdef").into(),
        ]
    }

    #[test]
    fn legacy_checkpoint_form_loads_without_restoring_emergency_cutoff() {
        let checkpoint = checkpoint();
        assert!(checkpoint.continuation.form.validate().is_ok());
        let value = serde_json::to_value(&checkpoint.continuation.form).unwrap();
        assert!(value["settings"].get("minHpPercent").is_none());
    }

    #[test]
    fn runtime_validation_uses_supplied_time_and_rejects_unsettled_or_sensitive_state() {
        let mut value = runtime();
        assert!(validate_runtime(&value, 999).is_err());
        validate_runtime(&value, 1000).unwrap();
        validate_runtime(&value, 1100).unwrap();
        value["partyHeal"]["confirmed"] = 3.into();
        assert!(validate_runtime(&value, 1100).is_err());
        value = runtime();
        value["status"]["rawPacket"] = json!([1, 2]);
        assert!(validate_runtime(&value, 1100).is_err());
        value = runtime();
        value["status"]["runRequested"] = true.into();
        assert!(validate_runtime(&value, 1100).is_err());
    }

    #[test]
    fn checkpoint_eligibility_requires_launch_proof_and_inclusive_time_bounds() {
        let bytes = encode_checkpoint(&checkpoint(), 1000).unwrap();
        for at in [1000, 1000 + TTL_MS] {
            assert!(eligible_checkpoint(&bytes, &arguments(), "1.2.3", at, at).is_some());
        }
        for at in [999, 1000 + TTL_MS + 1] {
            assert!(eligible_checkpoint(&bytes, &arguments(), "1.2.3", at, 1000).is_none());
        }
        assert!(eligible_checkpoint(&bytes, &arguments(), "1.2.4", 1000, 1000).is_none());
        assert!(eligible_checkpoint(&bytes, &arguments(), "1.2.3", 1000, 999).is_none());
        let mut args = arguments();
        args.push(args[1].clone());
        assert!(eligible_checkpoint(&bytes, &args, "1.2.3", 1000, 1000).is_none());
        let mut args = arguments();
        args.push(STOPPED_FLAG.into());
        assert!(eligible_checkpoint(&bytes, &args, "1.2.3", 1000, 1000).is_none());
        assert!(eligible_checkpoint(&bytes, &["Companion".into()], "1.2.3", 1000, 1000).is_none());
    }

    #[test]
    fn admitted_continuation_projects_the_same_wire_document_and_checked_identity_matches_both_channels(
    ) {
        let payload = checkpoint().continuation;
        let expected = serde_json::to_vec(&payload).unwrap();
        let identity = runtime_identity(&payload.runtime).unwrap();
        let mut observed = GameIdentity {
            session_id: payload.runtime["status"]["sessionId"]
                .as_str()
                .unwrap()
                .into(),
            connection_id: payload.runtime["status"]["connectionId"]
                .as_str()
                .unwrap()
                .into(),
        };
        assert!(identity.matches(&observed));
        observed.connection_id = "different".into();
        assert!(!identity.matches(&observed));
        observed.connection_id = payload.runtime["status"]["connectionId"]
            .as_str()
            .unwrap()
            .into();
        observed.session_id = "different".into();
        assert!(!identity.matches(&observed));
        let admitted = AdmittedContinuation::admit(payload, 1000).unwrap();
        assert_eq!(serde_json::to_vec(admitted.raw()).unwrap(), expected);
        assert_eq!(serde_json::to_vec(&admitted.into_wire()).unwrap(), expected);
    }

    #[test]
    fn corrupt_oversized_and_unknown_checkpoint_documents_have_no_authority() {
        assert!(eligible_checkpoint(b"corrupt", &arguments(), "1.2.3", 1000, 1000).is_none());
        assert!(eligible_checkpoint(
            &vec![b' '; MAX_BYTES as usize + 1],
            &arguments(),
            "1.2.3",
            1000,
            1000
        )
        .is_none());
        let mut value = serde_json::to_value(checkpoint()).unwrap();
        value["unknown"] = true.into();
        assert!(eligible_checkpoint(
            &serde_json::to_vec(&value).unwrap(),
            &arguments(),
            "1.2.3",
            1000,
            1000
        )
        .is_none());
        let mut disk = checkpoint();
        disk.continuation.version = 2;
        assert!(encode_checkpoint(&disk, 1000).is_err());
    }
}
