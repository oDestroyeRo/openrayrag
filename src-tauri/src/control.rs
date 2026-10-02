use serde_json::{Map, Value};
use std::collections::HashSet;
use std::sync::OnceLock;

const MAX_REQUEST_BYTES: usize = 65_536;
const MAX_ID: i64 = i32::MAX as i64;

type Validation = Result<(), String>;
type Object = Map<String, Value>;

fn invalid() -> String {
    "Invalid automation request.".into()
}

fn object<'a>(value: &'a Value, keys: &[&str]) -> Result<&'a Object, String> {
    let object = value.as_object().ok_or_else(invalid)?;
    if object.keys().any(|key| !keys.contains(&key.as_str())) {
        return Err(invalid());
    }
    Ok(object)
}

fn field<'a>(object: &'a Object, key: &str) -> Result<&'a Value, String> {
    object.get(key).ok_or_else(invalid)
}

fn string<'a>(object: &'a Object, key: &str) -> Result<&'a str, String> {
    field(object, key)?.as_str().ok_or_else(invalid)
}

fn number(value: &Value, min: i64, max: i64) -> Result<i64, String> {
    value
        .as_i64()
        .filter(|value| (min..=max).contains(value))
        .ok_or_else(invalid)
}

fn integer(object: &Object, key: &str, min: i64, max: i64) -> Result<i64, String> {
    number(field(object, key)?, min, max)
}

fn boolean(object: &Object, key: &str) -> Validation {
    field(object, key)?
        .as_bool()
        .map(|_| ())
        .ok_or_else(invalid)
}

fn array(value: &Value, max: usize) -> Result<&[Value], String> {
    value
        .as_array()
        .filter(|values| values.len() <= max)
        .map(Vec::as_slice)
        .ok_or_else(invalid)
}

fn text(value: &str, max: usize) -> Validation {
    // Match JavaScript String.trim(), including its byte-order-mark whitespace.
    if value
        .trim_matches(|c| {
            matches!(
                c,
                '\u{0009}'..='\u{000d}'
                    | ' '
                    | '\u{00a0}'
                    | '\u{1680}'
                    | '\u{2000}'..='\u{200a}'
                    | '\u{2028}'
                    | '\u{2029}'
                    | '\u{202f}'
                    | '\u{205f}'
                    | '\u{3000}'
                    | '\u{feff}'
            )
        })
        .is_empty()
        || value.encode_utf16().count() > max
        || value.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}')
    {
        return Err(invalid());
    }
    Ok(())
}

fn name(value: &str) -> Validation {
    text(value, 32)
}

fn map_code(value: &str) -> Validation {
    if value.is_empty()
        || value.len() > 64
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(invalid());
    }
    Ok(())
}

fn barter(action: &Object) -> Validation {
    integer(action, "choice", 0, 63)?;
    integer(action, "count", 1, 99)?;
    let mut ids = HashSet::new();
    for id in array(field(action, "bagIds")?, 10)? {
        if !ids.insert(number(id, 1, MAX_ID)?) {
            return Err(invalid());
        }
    }
    Ok(())
}

fn rows(value: &Value, max: usize, priced: bool) -> Validation {
    let mut ids = HashSet::new();
    for row in array(value, max)? {
        let row = object(
            row,
            if priced {
                &["id", "count", "price"]
            } else {
                &["id", "count"]
            },
        )?;
        if !ids.insert(integer(row, "id", 1, MAX_ID)?) {
            return Err(invalid());
        }
        integer(row, "count", 1, 32767)?;
        if priced {
            integer(row, "price", 0, 9_999_999)?;
        }
    }
    Ok(())
}

fn position(value: &Value) -> Validation {
    let position = object(value, &["x", "y"])?;
    integer(position, "x", 0, 4096)?;
    integer(position, "y", 0, 4096)?;
    Ok(())
}

pub(crate) fn validate_action(value: &Value) -> Validation {
    let kind = value
        .as_object()
        .and_then(|object| object.get("type"))
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    match kind {
        "sit" => {
            let action = object(value, &["type", "sitting"])?;
            boolean(action, "sitting")?;
        }
        "useItem" => {
            let action = object(value, &["type", "itemId", "target"])?;
            integer(action, "itemId", 1, MAX_ID)?;
            if let Some(target) = action.get("target") {
                let target = number(target, -1, MAX_ID)?;
                if target != -1 && target < 0 {
                    return Err(invalid());
                }
            }
        }
        "skill" => {
            let action = value.as_object().ok_or_else(invalid)?;
            match string(action, "mode")? {
                "self" => {
                    let action = object(value, &["type", "mode", "skillId", "level"])?;
                    integer(action, "skillId", 1, 32767)?;
                    integer(action, "level", 1, 255)?;
                }
                "target" => {
                    let action = object(value, &["type", "mode", "skillId", "level", "target"])?;
                    integer(action, "skillId", 1, 255)?;
                    integer(action, "level", 1, 255)?;
                    integer(action, "target", 0, MAX_ID)?;
                }
                "ground" => {
                    let action = object(value, &["type", "mode", "skillId", "level", "position"])?;
                    integer(action, "skillId", 1, 255)?;
                    integer(action, "level", 1, 255)?;
                    position(field(action, "position")?)?;
                }
                _ => return Err(invalid()),
            }
        }
        "equip" => {
            let action = object(value, &["type", "bagId", "equipped"])?;
            integer(action, "bagId", 1, MAX_ID)?;
            boolean(action, "equipped")?;
        }
        "respawn" | "npcAdvance" | "npcBarterCancel" | "partyLeave" | "partyDisband"
        | "vendingStop" => {
            object(value, &["type"])?;
        }
        "allocateSkill" => {
            let action = object(value, &["type", "skillId"])?;
            integer(action, "skillId", 1, 255)?;
        }
        "allocateStats" => {
            let action = object(value, &["type", "attributes"])?;
            let attributes = array(field(action, "attributes")?, 6)?;
            if attributes.len() != 6 {
                return Err(invalid());
            }
            let mut positive = false;
            for value in attributes {
                positive |= number(value, 0, 99)? > 0;
            }
            if !positive {
                return Err(invalid());
            }
        }
        "npcTalk" | "partyInviteId" | "vendingView" => {
            let action = object(value, &["type", "id"])?;
            integer(action, "id", 0, MAX_ID)?;
        }
        "npcOption" => {
            let action = object(value, &["type", "index"])?;
            integer(action, "index", 0, 31)?;
        }
        "shop" => {
            let action = object(value, &["type", "mode", "rows"])?;
            let max = match string(action, "mode")? {
                "buy" => 20,
                "sell" => 200,
                _ => return Err(invalid()),
            };
            rows(field(action, "rows")?, max, false)?;
        }
        "storage" => {
            let action = value.as_object().ok_or_else(invalid)?;
            match string(action, "operation")? {
                "close" => {
                    object(value, &["type", "operation"])?;
                }
                "deposit" | "withdraw" => {
                    let action = object(value, &["type", "operation", "bagId", "count"])?;
                    integer(action, "bagId", 1, MAX_ID)?;
                    integer(action, "count", 1, 32767)?;
                }
                _ => return Err(invalid()),
            }
        }
        "npcBarter" => {
            let action = object(value, &["type", "choice", "count", "bagIds"])?;
            barter(action)?;
        }
        "cart" => {
            let action = object(value, &["type", "direction", "bagId", "count"])?;
            integer(action, "direction", 1, 2)?;
            integer(action, "bagId", 1, MAX_ID)?;
            integer(action, "count", 1, 32767)?;
        }
        "partyCreate" => {
            let action = object(value, &["type", "name", "inviteId"])?;
            name(string(action, "name")?)?;
            if let Some(invite_id) = action.get("inviteId") {
                number(invite_id, 1, MAX_ID)?;
            }
        }
        "partyInviteName" => {
            let action = object(value, &["type", "name"])?;
            name(string(action, "name")?)?;
        }
        "partyAccept" => {
            let action = object(value, &["type", "partyId"])?;
            integer(action, "partyId", 1, MAX_ID)?;
        }
        "partyLeader" | "partyRemove" => {
            let action = object(value, &["type", "memberId"])?;
            integer(action, "memberId", 1, MAX_ID)?;
        }
        "vendingStart" => {
            let action = object(value, &["type", "name", "rows"])?;
            name(string(action, "name")?)?;
            let entries = field(action, "rows")?;
            if array(entries, 32)?.is_empty() {
                return Err(invalid());
            }
            rows(entries, 32, true)?;
        }
        "vendingPurchase" => {
            let action = object(value, &["type", "rows"])?;
            rows(field(action, "rows")?, 32, false)?;
        }
        _ => return Err("Unknown automation action.".into()),
    }
    Ok(())
}

fn expected_cost(step: &Object) -> Validation {
    if let Some(cost) = step.get("expectedCost") {
        number(cost, 0, 2_000_000_000)?;
    }
    Ok(())
}

fn validate_workflow(value: &Value) -> Validation {
    let workflow = object(
        value,
        &[
            "name",
            "map",
            "npcId",
            "maxSpend",
            "minStock",
            "steps",
            "timeoutMs",
        ],
    )?;
    text(string(workflow, "name")?, 64)?;
    map_code(string(workflow, "map")?)?;
    integer(workflow, "npcId", 0, MAX_ID)?;
    integer(workflow, "maxSpend", 0, 2_000_000_000)?;
    if let Some(timeout) = workflow.get("timeoutMs") {
        number(timeout, 1000, 60_000)?;
    }
    let mut ids = HashSet::new();
    for row in array(field(workflow, "minStock")?, 100)? {
        let row = object(row, &["itemId", "count"])?;
        if !ids.insert(integer(row, "itemId", 1, MAX_ID)?) {
            return Err(invalid());
        }
        integer(row, "count", 0, 32767)?;
    }
    let steps = array(field(workflow, "steps")?, 32)?;
    if steps.is_empty() {
        return Err(invalid());
    }
    for value in steps {
        let step = value.as_object().ok_or_else(invalid)?;
        match string(step, "type")? {
            "talk" => {
                let step = object(value, &["type", "expectedCost"])?;
                expected_cost(step)?;
            }
            "closeShop" | "closeStorage" | "cancelBarter" => {
                object(value, &["type"])?;
            }
            "advance" => {
                let step = object(
                    value,
                    &["type", "expectedText", "exactDialogue", "expectedCost"],
                )?;
                if let Some(expected) = step.get("expectedText") {
                    text(expected.as_str().ok_or_else(invalid)?, 1024)?;
                }
                if let Some(dialog) = step.get("exactDialogue") {
                    let dialog = object(dialog, &["name", "text"])?;
                    text(string(dialog, "name")?, 128)?;
                    text(string(dialog, "text")?, 1024)?;
                }
                expected_cost(step)?;
            }
            "option" => {
                let step = object(
                    value,
                    &[
                        "type",
                        "index",
                        "expectedLabel",
                        "expectedOptions",
                        "expectedCost",
                    ],
                )?;
                integer(step, "index", 0, 31)?;
                text(string(step, "expectedLabel")?, 1024)?;
                if let Some(menus) = step.get("expectedOptions") {
                    let menus = array(menus, 4)?;
                    if menus.is_empty() {
                        return Err(invalid());
                    }
                    for menu in menus {
                        let labels = array(menu, 32)?;
                        if labels.is_empty() {
                            return Err(invalid());
                        }
                        for label in labels {
                            let label = label.as_str().ok_or_else(invalid)?;
                            if label.encode_utf16().count() > 1024
                                || label.chars().any(|c| c <= '\u{001f}' || c == '\u{007f}')
                            {
                                return Err(invalid());
                            }
                        }
                    }
                }
                expected_cost(step)?;
            }
            "buy" | "sell" => {
                let step = object(value, &["type", "rows"])?;
                let max = if string(step, "type")? == "buy" {
                    20
                } else {
                    200
                };
                let entries = field(step, "rows")?;
                if array(entries, max)?.is_empty() {
                    return Err(invalid());
                }
                rows(entries, max, false)?;
            }
            "deposit" | "withdraw" => {
                let step = object(value, &["type", "bagId", "count"])?;
                integer(step, "bagId", 1, MAX_ID)?;
                integer(step, "count", 1, 32767)?;
            }
            "barter" => {
                let step = object(value, &["type", "choice", "count", "bagIds"])?;
                barter(step)?;
            }
            _ => return Err("Unknown workflow step.".into()),
        }
    }
    Ok(())
}

/// Only source-verified immutable contracts cross the native boundary.
/// Saved drafts are validated separately in the UI and remain unavailable.
fn validate_service(value: &Value) -> Validation {
    let service = object(
        value,
        &[
            "version",
            "id",
            "name",
            "contractId",
            "sourcePin",
            "sourcePath",
            "map",
            "identity",
            "approach",
            "basicSkillLevel",
            "workflow",
            "outcome",
        ],
    )?;
    integer(service, "version", 1, 1)?;
    map_code(string(service, "id")?)?;
    text(string(service, "name")?, 64)?;
    text(string(service, "contractId")?, 128)?;
    let workflow = object(
        field(service, "workflow")?,
        &["maxSpend", "minStock", "timeoutMs", "steps"],
    )?;
    let mut bound_workflow = workflow.clone();
    bound_workflow.insert("name".into(), field(service, "name")?.clone());
    bound_workflow.insert("map".into(), field(service, "map")?.clone());
    bound_workflow.insert("npcId".into(), Value::from(1));
    validate_workflow(&Value::Object(bound_workflow))?;
    integer(workflow, "timeoutMs", 1000, 60_000)?;
    let catalog: Value = serde_json::from_str(include_str!("../../src/data/npc-services.json"))
        .map_err(|_| invalid())?;
    let known = catalog["contracts"]
        .as_array()
        .ok_or_else(invalid)?
        .iter()
        .find(|known| known["contractId"] == value["contractId"])
        .ok_or("No verified adapter for this service contract.")?;
    for key in [
        "version",
        "contractId",
        "sourcePin",
        "sourcePath",
        "map",
        "identity",
        "approach",
        "basicSkillLevel",
        "outcome",
    ] {
        if field(service, key)? != &known[key] {
            return Err("Service differs from the verified contract.".into());
        }
    }
    if field(workflow, "steps")? != &known["workflow"]["steps"] {
        return Err("Service steps differ from the verified contract.".into());
    }
    Ok(())
}

fn finite(value: &Value, min: f64, max: f64) -> Validation {
    if value
        .as_f64()
        .is_some_and(|value| value.is_finite() && value >= min && value <= max)
    {
        Ok(())
    } else {
        Err(invalid())
    }
}

pub(crate) fn validate_actor_predicate(value: &Value) -> Validation {
    validate_actor_predicate_for(value, false)
}
pub(crate) fn validate_actor_predicate_for(value: &Value, allow_candidate: bool) -> Validation {
    let condition = value.as_object().ok_or_else(invalid)?;
    let kind = string(condition, "field")?;
    match kind {
        "actorStatus" => {
            object(value, &["field", "actor", "statusId", "operator", "value"])?;
            integer(condition, "statusId", 1, 255)?;
        }
        "actorCasting" => {
            object(value, &["field", "actor", "skillId", "operator", "value"])?;
            if condition.contains_key("skillId") {
                integer(condition, "skillId", 1, 255)?;
            }
        }
        _ => return Err(invalid()),
    }
    if !matches!(string(condition, "operator")?, "eq" | "ne") {
        return Err(invalid());
    }
    boolean(condition, "value")?;
    let actor_value = field(condition, "actor")?;
    let actor = actor_value.as_object().ok_or_else(invalid)?;
    match string(actor, "scope")? {
        "candidate" if allow_candidate => {
            object(actor_value, &["scope"])?;
        }
        "self" | "target" => {
            object(actor_value, &["scope"])?;
        }
        "actor" => {
            object(actor_value, &["scope", "id", "world", "incarnation"])?;
            integer(actor, "id", 0, MAX_ID)?;
            integer(actor, "incarnation", 1, MAX_ID)?;
            let world = string(actor, "world")?;
            if world.len() != 36
                || !world.bytes().enumerate().all(|(index, c)| {
                    if [8, 13, 18, 23].contains(&index) {
                        c == b'-'
                    } else {
                        c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
                    }
                })
            {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    Ok(())
}

fn validate_condition(value: &Value) -> Validation {
    let condition = value.as_object().ok_or_else(invalid)?;
    let kind = string(condition, "field")?;
    let operator = string(condition, "operator")?;
    if matches!(kind, "actorStatus" | "actorCasting") {
        return validate_actor_predicate(value);
    }
    if kind == "map" {
        object(value, &["field", "operator", "value"])?;
        if !matches!(operator, "eq" | "ne") {
            return Err(invalid());
        }
        return map_code(string(condition, "value")?);
    }
    if !matches!(operator, "lt" | "lte" | "eq" | "gte" | "gt") {
        return Err(invalid());
    }
    if kind == "inventory" {
        object(value, &["field", "itemId", "operator", "value"])?;
        integer(condition, "itemId", 1, MAX_ID)?;
        integer(condition, "value", 0, MAX_ID)?;
        return Ok(());
    }
    object(value, &["field", "operator", "value"])?;
    match kind {
        "hpPercent" | "spPercent" => finite(field(condition, "value")?, 0.0, 100.0),
        "elapsedSeconds" => finite(field(condition, "value")?, 0.0, 86_400.0),
        "zeny" => integer(condition, "value", 0, MAX_ID).map(|_| ()),
        _ => Err("Unknown routine condition.".into()),
    }
}

fn bounded_json(value: &Value, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) => true,
        Value::Number(number) => number.as_f64().is_some_and(f64::is_finite),
        Value::String(value) => value.encode_utf16().count() <= 4096,
        Value::Array(values) => {
            values.len() <= 64 && values.iter().all(|value| bounded_json(value, depth + 1))
        }
        Value::Object(values) => {
            values.len() <= 64 && values.values().all(|value| bounded_json(value, depth + 1))
        }
    }
}

fn validate_routine(value: &Value) -> Validation {
    let routine = object(value, &["name", "durationSeconds", "maxActions", "rules"])?;
    text(string(routine, "name")?, 64)?;
    integer(routine, "durationSeconds", 1, 86_400)?;
    integer(routine, "maxActions", 1, 1000)?;
    let rules = array(field(routine, "rules")?, 32)?;
    if rules.is_empty() {
        return Err(invalid());
    }
    let mut names = HashSet::new();
    for value in rules {
        let rule = object(
            value,
            &[
                "name",
                "priority",
                "cooldownSeconds",
                "maxRuns",
                "conditions",
                "action",
            ],
        )?;
        let rule_name = string(rule, "name")?;
        text(rule_name, 64)?;
        if !names.insert(rule_name) {
            return Err("Routine rule names must be unique.".into());
        }
        integer(rule, "priority", -1000, 1000)?;
        integer(rule, "cooldownSeconds", 0, 86_400)?;
        integer(rule, "maxRuns", 1, 1000)?;
        let conditions = array(field(rule, "conditions")?, 16)?;
        if conditions.is_empty() {
            return Err(invalid());
        }
        for condition in conditions {
            validate_condition(condition)?;
        }
        let action = field(rule, "action")?;
        if !bounded_json(action, 0)
            || serde_json::to_vec(action).map_err(|_| invalid())?.len() > 4096
        {
            return Err("Routine action exceeds its limit.".into());
        }
        validate_action(action)?;
    }
    Ok(())
}

fn validate_memo(value: &Value) -> Validation {
    let request = object(value, &["type", "slot", "preview"])?;
    if string(request, "type")? != "memoSave" {
        return Err(invalid());
    }
    integer(request, "slot", 0, 3)?;
    let preview = object(
        field(request, "preview")?,
        &[
            "world",
            "actorId",
            "incarnation",
            "connectionEpoch",
            "revision",
            "map",
            "x",
            "y",
        ],
    )?;
    integer(preview, "actorId", 0, MAX_ID)?;
    for key in ["incarnation", "connectionEpoch", "revision"] {
        integer(preview, key, 1, MAX_ID)?;
    }
    for key in ["x", "y"] {
        integer(preview, key, 0, 511)?;
    }
    let map = string(preview, "map")?;
    if map.is_empty()
        || map.len() > 64
        || !map
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    {
        return Err(invalid());
    }
    let world = string(preview, "world")?;
    if world.len() != 36
        || !world.bytes().enumerate().all(|(index, c)| {
            if [8, 13, 18, 23].contains(&index) {
                c == b'-'
            } else {
                c.is_ascii_digit() || (b'a'..=b'f').contains(&c)
            }
        })
    {
        return Err(invalid());
    }
    Ok(())
}

fn validate_social(value: &Value) -> Validation {
    let kind = value
        .as_object()
        .and_then(|value| value.get("type"))
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    match kind {
        "chat" => {
            let action = object(value, &["type", "channel", "text"])?;
            integer(action, "channel", 0, 2)?;
            let value = string(action, "text")?;
            // Rust White_Space and TS Unicode White_Space deliberately match.
            // Never trim or normalize accepted content; serde rejects lone surrogates.
            if value.is_empty()
                || value.chars().all(char::is_whitespace)
                || value.encode_utf16().count() > 140
            {
                return Err(invalid());
            }
        }
        "emote" => {
            let action = object(value, &["type", "id"])?;
            let id = integer(action, "id", 0, 100)?;
            static IDS: OnceLock<HashSet<i64>> = OnceLock::new();
            let ids = IDS.get_or_init(|| {
                let catalog: Value =
                    serde_json::from_str(include_str!("../../src/data/emote-catalog.json"))
                        .expect("Emote catalog must be valid");
                catalog["items"]
                    .as_array()
                    .expect("Emote catalog items")
                    .iter()
                    .map(|item| item["id"].as_i64().expect("Emote ID"))
                    .collect()
            });
            if !ids.contains(&id) {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    Ok(())
}

fn validate_socket(request: &Value, commit: bool) -> Validation {
    let keys = if commit {
        vec!["targetBagId", "cardBagId", "previewToken", "policy"]
    } else {
        vec!["targetBagId", "cardBagId", "policy"]
    };
    let v = object(request, &keys)?;
    if v.len() != keys.len() {
        return Err(invalid());
    }
    crate::automation::validate_manual_protection_policy(field(v, "policy")?)?;
    let target = integer(v, "targetBagId", 1, MAX_ID)?;
    let card = integer(v, "cardBagId", 1, MAX_ID)?;
    if target == card {
        return Err(invalid());
    }
    if commit {
        let token = string(v, "previewToken")?;
        if token.len() != 32
            || !token
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(invalid());
        }
    }
    Ok(())
}

pub(crate) fn validate_request(action: &str, request: &Value) -> Validation {
    if serde_json::to_vec(request).map_err(|_| invalid())?.len() > MAX_REQUEST_BYTES {
        return Err("Automation request exceeds its limit.".into());
    }
    match action {
        "command" => validate_action(request),
        "workflow" => validate_workflow(request),
        "routine" => validate_routine(request),
        "service" => {
            if request
                .as_object()
                .is_some_and(|o| o.contains_key("service"))
            {
                let wrapper = object(request, &["service", "executionPolicy"])?;
                crate::automation::validate_map_policy(field(wrapper, "executionPolicy")?)?;
                validate_service(field(wrapper, "service")?)
            } else {
                validate_service(request)
            }
        }
        "social" => validate_social(request),
        "memo" => validate_memo(request),
        "socketPreview" => validate_socket(request, false),
        "socket" => validate_socket(request, true),
        _ => Err("Unknown bot action.".into()),
    }
}

pub(crate) fn request_script(action: &str, request: &Value) -> Result<String, String> {
    validate_request(action, request)?;
    let action_json = serde_json::to_string(action).map_err(|_| invalid())?;
    let request_json = serde_json::to_string(request).map_err(|_| invalid())?;
    Ok(format!(
        "window.__RAYRAG__?.perform({action_json},{request_json})"
    ))
}

#[cfg(test)]
mod tests {
    use super::{validate_action, validate_request};
    use serde_json::{json, Value};
    #[test]
    fn manual_memo_shared_corpus_and_automation_exclusion() {
        let cases: Value =
            serde_json::from_str(include_str!("../../src/data/memo-request-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                validate_request("memo", &case["request"]).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            for mode in ["command", "workflow", "service", "social"] {
                assert!(validate_request(mode, &case["request"]).is_err());
            }
            let routine = json!({"name":"No memo automation","durationSeconds":10,"maxActions":1,"rules":[{"name":"Rejected","priority":0,"cooldownSeconds":1,"maxRuns":1,"conditions":[{"field":"hpPercent","operator":"lt","value":100}],"action":case["request"]}]});
            assert!(validate_request("routine", &routine).is_err());
        }
    }
    #[test]
    fn manual_social_shared_corpus_and_routine_exclusion() {
        let cases: serde_json::Value =
            serde_json::from_str(include_str!("../../src/data/social-request-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                validate_request("social", &case["request"]).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            assert!(validate_request("command", &case["request"]).is_err());
            assert!(validate_request("workflow", &case["request"]).is_err());
            assert!(validate_request("service", &case["request"]).is_err());
            let routine = json!({"name":"No social automation","durationSeconds":10,"maxActions":1,"rules":[{"name":"Rejected","priority":0,"cooldownSeconds":1,"maxRuns":1,"conditions":[{"field":"hpPercent","operator":"lt","value":100}],"action":case["request"]}]});
            assert!(validate_request("routine", &routine).is_err());
        }
        assert!(serde_json::from_str::<serde_json::Value>(
            r#"{"type":"chat","channel":0,"text":"\ud800"}"#
        )
        .is_err());
    }

    #[test]
    fn service_contract_shared_corpus() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../src/data/npc-service-request-cases.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                validate_request("service", &case["request"]).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn accepts_representative_feature_and_world_commands() {
        for action in [
            json!({"type":"sit","sitting":true}),
            json!({"type":"useItem","itemId":501}),
            json!({"type":"useItem","itemId":501,"target":-1}),
            json!({"type":"skill","mode":"self","skillId":32767,"level":255}),
            json!({"type":"skill","mode":"target","skillId":255,"level":255,"target":1}),
            json!({"type":"skill","mode":"ground","skillId":1,"level":1,"position":{"x":4096,"y":0}}),
            json!({"type":"equip","bagId":1,"equipped":false}),
            json!({"type":"respawn"}),
            json!({"type":"allocateSkill","skillId":255}),
            json!({"type":"allocateStats","attributes":[99,0,0,0,0,0]}),
            json!({"type":"npcTalk","id":1}),
            json!({"type":"npcAdvance"}),
            json!({"type":"npcOption","index":31}),
            json!({"type":"shop","mode":"buy","rows":[{"id":501,"count":32767}]}),
            json!({"type":"storage","operation":"close"}),
            json!({"type":"storage","operation":"withdraw","bagId":1,"count":1}),
            json!({"type":"npcBarter","choice":63,"count":1,"bagIds":[1,2]}),
            json!({"type":"npcBarterCancel"}),
            json!({"type":"cart","direction":2,"bagId":1,"count":1}),
            json!({"type":"partyCreate","name":"Example","inviteId":1}),
            json!({"type":"partyInviteId","id":1}),
            json!({"type":"partyInviteName","name":"Example"}),
            json!({"type":"partyAccept","partyId":1}),
            json!({"type":"partyLeave"}),
            json!({"type":"partyLeader","memberId":1}),
            json!({"type":"partyRemove","memberId":1}),
            json!({"type":"partyDisband"}),
            json!({"type":"vendingStart","name":"Example","rows":[{"id":1,"count":1,"price":9_999_999}]}),
            json!({"type":"vendingStop"}),
            json!({"type":"vendingView","id":1}),
            json!({"type":"vendingPurchase","rows":[{"id":1,"count":1}]}),
        ] {
            assert!(
                validate_request("command", &action).is_ok(),
                "rejected {action}"
            );
            let mut unknown = action;
            unknown
                .as_object_mut()
                .unwrap()
                .insert("script".into(), "alert(1)".into());
            assert!(validate_action(&unknown).is_err());
        }
    }

    #[test]
    fn rejects_wrong_types_missing_fields_unknown_fields_and_invalid_ranges() {
        for action in [
            json!(null),
            json!([]),
            json!({"type":"chat","message":"hello"}),
            json!({"type":"sit","sitting":1}),
            json!({"type":"sit"}),
            json!({"type":"useItem","itemId":0}),
            json!({"type":"useItem","itemId":1,"target":-2}),
            json!({"type":"useItem","itemId":1,"target":null}),
            json!({"type":"skill","mode":"self","skillId":1,"level":1,"target":1}),
            json!({"type":"skill","mode":"target","skillId":256,"level":1,"target":1}),
            json!({"type":"skill","mode":"ground","skillId":1,"level":1,"position":{"x":1,"y":1,"map":"x"}}),
            json!({"type":"skill","mode":"ground","skillId":1,"level":1,"position":{"x":4097,"y":1}}),
            json!({"type":"allocateStats","attributes":[0,0,0,0,0,0]}),
            json!({"type":"allocateStats","attributes":[100,0,0,0,0,0]}),
            json!({"type":"allocateStats","attributes":[1,0,0,0,0,0,0]}),
            json!({"type":"npcOption","index":32}),
            json!({"type":"shop","mode":"buy","rows":[{"id":1,"count":1,"price":1}]}),
            json!({"type":"shop","mode":"buy","rows":[{"id":1,"count":1},{"id":1,"count":2}]}),
            json!({"type":"storage","operation":"close","count":1}),
            json!({"type":"storage","operation":"withdraw","bagId":1,"count":32768}),
            json!({"type":"npcBarter","choice":0,"count":1,"bagIds":[1,1]}),
            json!({"type":"npcBarter","choice":0,"count":100,"bagIds":[]}),
            json!({"type":"npcBarter","choice":0,"count":1,"bagIds":(1..=11).collect::<Vec<_>>()}),
            json!({"type":"cart","direction":3,"bagId":1,"count":1}),
            json!({"type":"partyCreate","name":"Example","inviteId":null}),
            json!({"type":"partyInviteName","name":"x\n"}),
            json!({"type":"partyInviteName","name":"😀".repeat(17)}),
            json!({"type":"vendingStart","name":"Example","rows":[]}),
            json!({"type":"vendingStart","name":"Example","rows":[{"id":1,"count":1,"price":10_000_000}]}),
        ] {
            assert!(validate_action(&action).is_err(), "accepted {action}");
        }
    }

    #[test]
    fn enforces_size_and_array_bounds() {
        for (kind, max) in [("buy", 20), ("sell", 200)] {
            let rows = (1..=max)
                .map(|id| json!({"id":id,"count":1}))
                .collect::<Vec<_>>();
            assert!(validate_action(&json!({"type":"shop","mode":kind,"rows":rows})).is_ok());
            let rows = (1..=max + 1)
                .map(|id| json!({"id":id,"count":1}))
                .collect::<Vec<_>>();
            assert!(validate_action(&json!({"type":"shop","mode":kind,"rows":rows})).is_err());
        }
        assert_eq!(
            validate_request(
                "command",
                &json!({"type":"partyCreate","name":"x".repeat(65_537)})
            )
            .unwrap_err(),
            "Automation request exceeds its limit."
        );
        assert!(validate_request("unknown", &json!({"type":"respawn"})).is_err());
    }
}

#[cfg(test)]
mod automation_request_tests {
    use super::{request_script, validate_action, validate_actor_predicate, validate_request};
    use serde_json::{json, Value};

    #[test]
    fn actor_zero_field_contract_matches_typescript() {
        let cases: Value =
            serde_json::from_str(include_str!("../../src/data/actor-zero-request-cases.json"))
                .unwrap();
        for action in cases["valid"].as_array().unwrap() {
            assert!(validate_action(action).is_ok(), "rejected {action}");
        }
        for action in cases["invalid"].as_array().unwrap() {
            assert!(validate_action(action).is_err(), "accepted {action}");
        }
        let mut spec = workflow();
        spec["npcId"] = json!(0);
        assert!(validate_request("workflow", &spec).is_ok());
        let actor = json!({"field":"actorCasting","actor":{"scope":"actor","id":0,"incarnation":1,"world":"00000000-0000-0000-0000-000000000001"},"operator":"eq","value":false});
        assert!(validate_actor_predicate(&actor).is_ok());
        for (field, value) in [
            ("id", json!(-1)),
            ("id", json!(null)),
            ("incarnation", json!(0)),
        ] {
            let mut bad = actor.clone();
            bad["actor"][field] = value;
            assert!(validate_actor_predicate(&bad).is_err());
        }
    }

    fn workflow() -> Value {
        json!({
            "name":"Restock", "map":"prontera", "npcId":1,
            "maxSpend":2000, "minStock":[{"itemId":501,"count":2}],
            "steps":[{"type":"talk"},{"type":"option","index":0,"expectedLabel":"Buy"},
                {"type":"buy","rows":[{"id":501,"count":2}]},{"type":"closeShop"}],
            "timeoutMs":60000
        })
    }

    fn routine() -> Value {
        json!({
            "name":"HP recovery", "durationSeconds":86400, "maxActions":1000,
            "rules":[{
                "name":"Recover", "priority":-1000, "cooldownSeconds":0, "maxRuns":1000,
                "conditions":[{"field":"hpPercent","operator":"lt","value":65.5},
                    {"field":"spPercent","operator":"gte","value":10.25},
                    {"field":"elapsedSeconds","operator":"gt","value":0.5},
                    {"field":"map","operator":"eq","value":"prt_fild08"},
                    {"field":"zeny","operator":"lte","value":2147483647},
                    {"field":"inventory","itemId":501,"operator":"gt","value":0}],
                "action":{"type":"useItem","itemId":501}
            }]
        })
    }

    #[test]
    fn accepts_workflows_and_checks_step_fields_and_limits() {
        assert!(validate_request("workflow", &workflow()).is_ok());
        for step in [
            json!({"type":"advance"}),
            json!({"type":"advance","expectedText":"Hello"}),
            json!({"type":"deposit","bagId":1,"count":32767}),
            json!({"type":"withdraw","bagId":1,"count":1}),
            json!({"type":"closeStorage"}),
            json!({"type":"cancelBarter"}),
            json!({"type":"barter","choice":63,"count":99,"bagIds":[]}),
        ] {
            let mut value = workflow();
            value["steps"] = json!([step]);
            assert!(
                validate_request("workflow", &value).is_ok(),
                "rejected {value}"
            );
            value["steps"][0]["unknown"] = true.into();
            assert!(validate_request("workflow", &value).is_err());
        }
        for (path, invalid) in [
            ("/map", json!("../map")),
            ("/npcId", json!(-1)),
            ("/maxSpend", json!(2_000_000_001)),
            ("/timeoutMs", json!(999)),
            ("/timeoutMs", json!(null)),
            (
                "/minStock",
                json!([{"itemId":1,"count":0},{"itemId":1,"count":1}]),
            ),
            ("/minStock", json!([{"itemId":1,"count":1,"unknown":true}])),
            ("/steps", json!([])),
            ("/steps", json!([{"type":"attack","id":1}])),
            ("/steps", json!([{"type":"buy","rows":[]}])),
            ("/steps", json!([{"type":"advance","expectedText":null}])),
            (
                "/steps",
                json!([{"type":"option","index":0,"expectedLabel":""}]),
            ),
        ] {
            let mut value = workflow();
            *value.pointer_mut(path).unwrap() = invalid;
            assert!(
                validate_request("workflow", &value).is_err(),
                "accepted {value}"
            );
        }
        let mut value = workflow();
        value["unknown"] = true.into();
        assert!(validate_request("workflow", &value).is_err());
        value.as_object_mut().unwrap().remove("unknown");
        value["steps"] = json!(vec![json!({"type":"talk"}); 33]);
        assert!(validate_request("workflow", &value).is_err());
    }

    #[test]
    fn restricts_expected_npc_cost_to_dialog_steps_and_integer_bounds() {
        for step in [
            json!({"type":"talk"}),
            json!({"type":"advance","expectedText":"Hello"}),
            json!({"type":"option","index":0,"expectedLabel":"Open storage"}),
        ] {
            let mut value = workflow();
            value["steps"] = json!([step]);
            assert!(validate_request("workflow", &value).is_ok());
            for cost in [json!(0), json!(40), json!(2_000_000_000)] {
                value["steps"][0]["expectedCost"] = cost;
                assert!(validate_request("workflow", &value).is_ok());
            }
            for cost in [
                json!(-1),
                json!(2_000_000_001),
                json!(0.5),
                json!(null),
                json!("40"),
            ] {
                value["steps"][0]["expectedCost"] = cost;
                assert!(validate_request("workflow", &value).is_err());
            }
        }
        for step in [
            json!({"type":"closeShop","expectedCost":0}),
            json!({"type":"closeStorage","expectedCost":0}),
            json!({"type":"cancelBarter","expectedCost":0}),
            json!({"type":"buy","rows":[{"id":501,"count":1}],"expectedCost":0}),
            json!({"type":"deposit","bagId":1,"count":1,"expectedCost":0}),
            json!({"type":"barter","choice":0,"count":1,"bagIds":[],"expectedCost":0}),
        ] {
            let mut value = workflow();
            value["steps"] = json!([step]);
            assert!(validate_request("workflow", &value).is_err());
        }
    }

    #[test]
    fn accepts_routine_fractions_and_rejects_unknown_or_unbounded_conditions() {
        assert!(validate_request("routine", &routine()).is_ok());
        for (path, invalid) in [
            ("/name", json!("")),
            ("/durationSeconds", json!(86401)),
            ("/maxActions", json!(0)),
            ("/rules", json!([])),
            ("/rules/0/priority", json!(-1001)),
            ("/rules/0/cooldownSeconds", json!(86401)),
            ("/rules/0/maxRuns", json!(1001)),
            ("/rules/0/conditions", json!([])),
            (
                "/rules/0/conditions",
                json!([{"field":"hpPercent","operator":"lt","value":100.1}]),
            ),
            (
                "/rules/0/conditions",
                json!([{"field":"zeny","operator":"eq","value":1.5}]),
            ),
            (
                "/rules/0/conditions",
                json!([{"field":"inventory","itemId":1,"operator":"eq","value":1.5}]),
            ),
            (
                "/rules/0/conditions",
                json!([{"field":"map","operator":"lt","value":"prontera"}]),
            ),
            (
                "/rules/0/conditions",
                json!([{"field":"map","operator":"eq","value":"prontera","itemId":1}]),
            ),
            (
                "/rules/0/conditions",
                json!([{"field":"elapsedSeconds","operator":"lte","value":86400.1}]),
            ),
            (
                "/rules/0/conditions",
                json!([{"field":"unknown","operator":"eq","value":1}]),
            ),
            ("/rules/0/action", json!({"type":"chat","message":"hello"})),
        ] {
            let mut value = routine();
            *value.pointer_mut(path).unwrap() = invalid;
            assert!(
                validate_request("routine", &value).is_err(),
                "accepted {value}"
            );
        }
        for path in ["", "/rules/0", "/rules/0/conditions/0", "/rules/0/action"] {
            let mut value = routine();
            value
                .pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unknown".into(), true.into());
            assert!(validate_request("routine", &value).is_err());
        }
        let mut value = routine();
        let rule = value["rules"][0].clone();
        value["rules"] = json!([rule.clone(), rule]);
        assert!(validate_request("routine", &value).is_err());
    }

    #[test]
    fn routine_actions_have_smaller_json_and_byte_budgets() {
        let mut value = routine();
        value["rules"][0]["action"] = json!({"type":"shop","mode":"sell","rows":(1..=65).map(|id|json!({"id":id,"count":1})).collect::<Vec<_>>()});
        assert!(validate_action(&value["rules"][0]["action"]).is_ok());
        assert!(validate_request("routine", &value).is_err());
        value["rules"][0]["action"] = json!({"type":"vendingStart","name":"Example","rows":(1..=32).map(|id|json!({"id":i32::MAX as i64-id,"count":32767,"price":9_999_999})).collect::<Vec<_>>()});
        assert!(validate_request("routine", &value).is_ok());
        value["rules"][0]["conditions"] = json!(vec![
            json!({"field":"hpPercent","operator":"gt","value":0});
            17
        ]);
        assert!(validate_request("routine", &value).is_err());
    }

    #[test]
    fn serializes_data_into_fixed_controller_calls() {
        let action = json!({"type":"partyCreate","name":"Example"});
        for (kind, value) in [
            ("command", action),
            ("workflow", workflow()),
            ("routine", routine()),
            (
                "social",
                json!({"type":"chat","channel":0,"text":"\"</script>\\\nwindow.alert(1); /literal %\u{2028}"}),
            ),
            ("social", json!({"type":"emote","id":58})),
        ] {
            let encoded = serde_json::to_string(&value).unwrap();
            assert_eq!(
                request_script(kind, &value).unwrap(),
                format!(
                    "window.__RAYRAG__?.perform({},{encoded})",
                    serde_json::to_string(kind).unwrap()
                )
            );
        }
        assert!(request_script("window.alert(1)", &json!({"type":"respawn"})).is_err());
    }
    #[test]
    fn actor_predicates_use_exact_typed_lifetime_bound_shapes() {
        for predicate in [
            json!({"field":"actorStatus","actor":{"scope":"self"},"statusId":1,"operator":"eq","value":false}),
            json!({"field":"actorCasting","actor":{"scope":"target"},"operator":"ne","value":true}),
            json!({"field":"actorCasting","actor":{"scope":"actor","id":2147483647,"incarnation":2147483647,"world":"00000000-0000-0000-0000-000000000001"},"skillId":255,"operator":"eq","value":true}),
        ] {
            assert!(validate_actor_predicate(&predicate).is_ok());
            let mut value = routine();
            value["rules"][0]["conditions"] = json!([predicate]);
            assert!(validate_request("routine", &value).is_ok());
        }
        for invalid in [
            json!({"field":"actorCasting","actor":{"scope":"candidate"},"operator":"eq","value":false}),
            json!({"field":"actorCasting","actor":{"scope":"self","id":1},"operator":"eq","value":false}),
            json!({"field":"actorCasting","actor":{"scope":"self"},"skillId":null,"operator":"eq","value":false}),
            json!({"field":"actorStatus","actor":{"scope":"self"},"statusId":0,"operator":"eq","value":false}),
            json!({"field":"actorCasting","actor":{"scope":"actor","id":1,"incarnation":1,"world":"bad"},"operator":"eq","value":false}),
            json!({"field":"actorCasting","actor":{"scope":"self"},"operator":"lt","value":false}),
            json!({"field":"actorCasting","actor":{"scope":"self"},"operator":"eq","value":0}),
            json!({"field":"actorCasting","actor":{"scope":"self"},"operator":"eq","value":false,"script":"code"}),
        ] {
            assert!(validate_actor_predicate(&invalid).is_err());
        }
    }
    #[test]
    fn service_execution_policy_is_separate_and_strict() {
        let cases: serde_json::Value = serde_json::from_str(include_str!(
            "../../src/data/npc-service-request-cases.json"
        ))
        .unwrap();
        let service = &cases
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["valid"] == true)
            .unwrap()["request"];
        let policy_cases: serde_json::Value =
            serde_json::from_str(include_str!("../../src/data/map-policy-cases.json")).unwrap();
        for case in policy_cases.as_array().unwrap() {
            let request = json!({"service":service,"executionPolicy":case["policy"]});
            assert_eq!(
                validate_request("service", &request).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
        assert!(validate_request("service", &json!({"service":service})).is_err());
        assert!(validate_request(
            "service",
            &json!({"service":service,"executionPolicy":null})
        )
        .is_err());
    }
}

#[cfg(test)]
mod socket_tests {
    use super::{request_script, validate_request};
    use serde_json::Value;
    #[test]
    fn shares_strict_manual_socket_request_corpus() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../src/data/socket-request-cases.json")).unwrap();
        for case in cases {
            let mode = case["mode"].as_str().unwrap();
            let request = &case["request"];
            assert_eq!(
                validate_request(mode, request).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            for other in [
                "command", "workflow", "routine", "service", "social", "memo",
            ] {
                assert!(validate_request(other, request).is_err());
            }
            if case["valid"].as_bool().unwrap() {
                assert!(request_script(mode, request)
                    .unwrap()
                    .starts_with("window.__RAYRAG__?.perform("));
            }
        }
    }
}
