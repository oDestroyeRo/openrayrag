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
            if integer(action, "skillId", 1, 32767)? == 55 {
                return Err(invalid());
            }
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
    for row in array(field(workflow, "minStock")?, 160)? {
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
        "actorHpPercent" | "actorSpPercent" => {
            object(value, &["field", "actor", "operator", "value"])?;
            finite(field(condition, "value")?, 0.0, 100.0)?;
        }
        _ => return Err(invalid()),
    }
    let resource = matches!(kind, "actorHpPercent" | "actorSpPercent");
    if resource {
        if !matches!(
            string(condition, "operator")?,
            "lt" | "lte" | "eq" | "gte" | "gt"
        ) {
            return Err(invalid());
        }
    } else {
        if !matches!(string(condition, "operator")?, "eq" | "ne") {
            return Err(invalid());
        }
        boolean(condition, "value")?;
    }
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
    if matches!(
        kind,
        "actorStatus" | "actorCasting" | "actorHpPercent" | "actorSpPercent"
    ) {
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
        "hpPercent" | "spPercent" | "weightPercent" => {
            finite(field(condition, "value")?, 0.0, 100.0)
        }
        "level" | "jobLevel" => integer(condition, "value", 1, 1000).map(|_| ()),
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

fn validate_macro_step(value: &Value, max_spend: i64) -> Validation {
    let step = value.as_object().ok_or_else(invalid)?;
    let kind = string(step, "type")?;
    match kind {
        "farm" => {
            object(value, &["type", "map", "targets", "timeoutSeconds"])?;
            map_code(string(step, "map")?)?;
            let targets = array(field(step, "targets")?, 64)?;
            if targets.is_empty() {
                return Err(invalid());
            }
            let mut ids = HashSet::new();
            for target in targets {
                if !ids.insert(number(target, 1, MAX_ID)?) {
                    return Err(invalid());
                }
            }
        }
        "travel" => {
            object(value, &["type", "map", "timeoutSeconds"])?;
            map_code(string(step, "map")?)?;
        }
        "buy" | "store" => {
            object(
                value,
                if kind == "buy" {
                    &[
                        "type",
                        "serviceId",
                        "itemId",
                        "quantity",
                        "maxSpend",
                        "timeoutSeconds",
                    ]
                } else {
                    &[
                        "type",
                        "serviceId",
                        "itemId",
                        "quantity",
                        "keep",
                        "maxSpend",
                        "timeoutSeconds",
                    ]
                },
            )?;
            integer(step, "itemId", 1, MAX_ID)?;
            integer(step, "quantity", 1, 100_000)?;
            integer(step, "maxSpend", 0, max_spend)?;
            if kind == "store" {
                integer(step, "keep", 0, 100_000)?;
            }
            let service_id = string(step, "serviceId")?;
            let catalog: Value =
                serde_json::from_str(include_str!("../../src/data/npc-services.json"))
                    .map_err(|_| invalid())?;
            let service = catalog["contracts"]
                .as_array()
                .ok_or_else(invalid)?
                .iter()
                .find(|service| service["id"].as_str() == Some(service_id))
                .ok_or("No verified adapter for this service ID.")?;
            let outcome = &service["outcome"];
            if !(kind == "buy" && outcome["type"] == "shopOpened" && outcome["mode"] == "buy"
                || kind == "store" && outcome["type"] == "storageOpened")
            {
                return Err("Service outcome does not match the macro step.".into());
            }
        }
        "useItem" => {
            object(value, &["type", "itemId", "timeoutSeconds"])?;
            integer(step, "itemId", 1, MAX_ID)?;
        }
        "skill" => {
            object(
                value,
                &["type", "skillId", "level", "mode", "timeoutSeconds"],
            )?;
            // Targeted skills use the existing byte-sized wire ID. Warp Portal
            // remains owned by the dedicated staged manual control.
            let max_skill_id = match string(step, "mode")? {
                "self" => 32767,
                "target" => 255,
                _ => return Err(invalid()),
            };
            if integer(step, "skillId", 1, max_skill_id)? == 55 {
                return Err(invalid());
            }
            integer(step, "level", 1, 10)?;
        }
        _ => return Err("Unknown macro step.".into()),
    }
    integer(
        step,
        "timeoutSeconds",
        1,
        if matches!(kind, "useItem" | "skill") {
            120
        } else {
            86_400
        },
    )?;
    Ok(())
}

fn validate_macro(value: &Value) -> Validation {
    let request = object(value, &["script", "settings"])?;
    let settings_value = field(request, "settings")?;
    if serde_json::to_vec(settings_value)
        .map_err(|_| invalid())?
        .len()
        > MAX_REQUEST_BYTES
    {
        return Err("Macro settings exceed their limit.".into());
    }
    validate_macro_script(field(request, "script")?)?;
    let settings: crate::automation::Settings =
        serde_json::from_value(settings_value.clone()).map_err(|_| invalid())?;
    settings.validate()
}

fn validate_macro_script(value: &Value) -> Validation {
    if serde_json::to_vec(value).map_err(|_| invalid())?.len() > MAX_REQUEST_BYTES {
        return Err("Macro script exceeds its limit.".into());
    }
    let script = object(
        value,
        &[
            "version",
            "name",
            "durationSeconds",
            "maxActions",
            "maxSpend",
            "rules",
        ],
    )?;
    integer(script, "version", 1, 1)?;
    text(string(script, "name")?, 64)?;
    // Zero disables these macro execution caps; step timeouts remain finite.
    integer(script, "durationSeconds", 0, 86_400)?;
    integer(script, "maxActions", 0, 1000)?;
    let max_spend = integer(script, "maxSpend", 0, 2_000_000_000)?;
    let rules = array(field(script, "rules")?, 32)?;
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
                "steps",
            ],
        )?;
        let rule_name = string(rule, "name")?;
        text(rule_name, 64)?;
        if !names.insert(rule_name) {
            return Err("Macro rule names must be unique.".into());
        }
        integer(rule, "priority", -1000, 1000)?;
        integer(rule, "cooldownSeconds", 0, 86_400)?;
        integer(rule, "maxRuns", 0, 1000)?;
        let conditions = array(field(rule, "conditions")?, 16)?;
        if conditions.is_empty() {
            return Err(invalid());
        }
        for condition in conditions {
            validate_condition(condition)?;
        }
        let steps = array(field(rule, "steps")?, 16)?;
        if steps.is_empty() {
            return Err(invalid());
        }
        for step in steps {
            validate_macro_step(step, max_spend)?;
        }
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

fn validate_warp(value: &Value, preview_only: bool) -> Validation {
    let kind = string(value.as_object().ok_or_else(invalid)?, "type")?;
    let keys = match (kind, preview_only) {
        ("warpGround", false) => vec!["type", "slot", "target", "preview", "policy"],
        ("warpGround", true) => vec!["type", "slot", "target", "policy"],
        ("warpActivate", false) => vec!["type", "preview", "policy"],
        ("warpActivate", true) => vec!["type", "policy"],
        _ => return Err(invalid()),
    };
    let request = object(value, &keys)?;
    if request.len() != keys.len() {
        return Err(invalid());
    }
    crate::automation::validate_manual_protection_policy(field(request, "policy")?)?;
    if kind == "warpGround" {
        integer(request, "slot", 0, 3)?;
        let target = object(field(request, "target")?, &["x", "y"])?;
        integer(target, "x", 0, 511)?;
        integer(target, "y", 0, 511)?;
    }
    if preview_only {
        return Ok(());
    }
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
            "generation",
            "level",
            "inventoryRevision",
            "equipmentRevision",
            "spRevision",
            "skillsRevision",
        ],
    )?;
    let mut base = preview.clone();
    for key in [
        "generation",
        "level",
        "inventoryRevision",
        "equipmentRevision",
        "spRevision",
        "skillsRevision",
    ] {
        base.remove(key);
    }
    validate_memo(&serde_json::json!({"type":"memoSave","slot":0,"preview":base}))?;
    integer(preview, "generation", 0, MAX_ID)?;
    integer(preview, "level", 1, 4)?;
    for key in [
        "inventoryRevision",
        "equipmentRevision",
        "spRevision",
        "skillsRevision",
    ] {
        integer(preview, key, 1, MAX_ID)?;
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

fn validate_refine(value: &Value, preview: bool) -> Validation {
    let fields = if preview {
        vec![
            "targetBagId",
            "catalystBagId",
            "policy",
            "maxSpend",
            "minZeny",
        ]
    } else {
        vec![
            "targetBagId",
            "catalystBagId",
            "policy",
            "maxSpend",
            "minZeny",
            "previewToken",
        ]
    };
    let request = object(value, &fields)?;
    integer(request, "targetBagId", 1, 2_147_483_647)?;
    integer(request, "catalystBagId", 0, 0)?;
    integer(request, "maxSpend", 0, 2_000_000_000)?;
    integer(request, "minZeny", 0, 2_147_483_647)?;
    crate::automation::validate_manual_protection_policy(field(request, "policy")?)?;
    if !preview {
        let token = string(request, "previewToken")?;
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

fn manual_identity(value: &Value) -> Result<&str, String> {
    let actor = object(value, &["world", "id", "incarnation"])?;
    integer(actor, "id", 0, MAX_ID)?;
    integer(actor, "incarnation", 1, MAX_ID)?;
    let world = string(actor, "world")?;
    if world.len() != 36
        || !world.bytes().enumerate().all(|(i, c)| {
            if matches!(i, 8 | 13 | 18 | 23) {
                c == b'-'
            } else {
                c.is_ascii_hexdigit()
            }
        })
    {
        return Err(invalid());
    }
    Ok(world)
}

fn validate_manual_target(value: &Value) -> Validation {
    let request = object(
        value,
        &[
            "type",
            "map",
            "owner",
            "command",
            "timeoutSeconds",
            "policy",
        ],
    )?;
    if string(request, "type")? != "manualTarget" {
        return Err(invalid());
    }
    let map = string(request, "map")?;
    map_code(map)?;
    let (width, height) = crate::map_dimensions(map).ok_or_else(invalid)?;
    let world = manual_identity(field(request, "owner")?)?;
    integer(request, "timeoutSeconds", 1, 120)?;
    let policy = object(
        field(request, "policy")?,
        &[
            "minHpPercent",
            "routeStep",
            "avoidWalls",
            "walkSeconds",
            "approachSeconds",
            "maxPathDistance",
            "levelDifference",
            "monsterRules",
            "minAmmoStock",
            "mapPolicy",
        ],
    )?;
    for (key, min, max) in [
        ("minHpPercent", 20, 95),
        ("routeStep", 1, 20),
        ("walkSeconds", 1, 600),
        ("approachSeconds", 1, 60),
        ("maxPathDistance", 1, 200),
        ("levelDifference", -100, 100),
        ("minAmmoStock", 0, 9999),
    ] {
        integer(policy, key, min, max)?;
    }
    boolean(policy, "avoidWalls")?;
    let mut ids = HashSet::new();
    for rule in array(field(policy, "monsterRules")?, 64)? {
        let rule = object(rule, &["classId", "action", "priority", "conditions"])?;
        if !ids.insert(integer(rule, "classId", 1, MAX_ID)?)
            || !matches!(string(rule, "action")?, "attack" | "ignore")
        {
            return Err(invalid());
        }
        integer(rule, "priority", -100, 100)?;
        if let Some(conditions) = rule.get("conditions") {
            for condition in array(conditions, 16)? {
                validate_actor_predicate_for(condition, true)?;
            }
        }
    }
    if let Some(policy) = policy.get("mapPolicy") {
        crate::automation::validate_map_policy(policy)?;
        if let Some(area) = policy.get("lockArea").filter(|v| !v.is_null()) {
            if area.get("map").and_then(Value::as_str) != Some(map) {
                return Err(invalid());
            }
        }
    }
    let command = field(request, "command")?;
    match command.get("type").and_then(Value::as_str) {
        Some("walk") => {
            let command = object(command, &["type", "destination"])?;
            let position = object(field(command, "destination")?, &["x", "y"])?;
            integer(position, "x", 0, width as i64 - 1)?;
            integer(position, "y", 0, height as i64 - 1)?;
        }
        Some("attack") => {
            let command = object(command, &["type", "target"])?;
            if manual_identity(field(command, "target")?)? != world {
                return Err(invalid());
            }
        }
        _ => return Err(invalid()),
    }
    Ok(())
}

pub(crate) fn validate_request(action: &str, request: &Value) -> Validation {
    // Leave room for both bounded macro fields while preserving all existing
    // request budgets. Validate each macro field before typed deserialization.
    let max_bytes = if action == "macro" {
        2 * MAX_REQUEST_BYTES
    } else {
        MAX_REQUEST_BYTES
    };
    if serde_json::to_vec(request).map_err(|_| invalid())?.len() > max_bytes {
        return Err("Automation request exceeds its limit.".into());
    }
    match action {
        "command" if request.get("type").and_then(Value::as_str) == Some("manualTarget") => {
            validate_manual_target(request)
        }
        "command" => validate_action(request),
        "workflow" => validate_workflow(request),
        "routine" => validate_routine(request),
        "macro" => validate_macro(request),
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
        "refinePreview" => validate_refine(request, true),
        "refine" => validate_refine(request, false),
        "refineAdvance" => {
            let request = object(request, &["promptToken"])?;
            let token = string(request, "promptToken")?;
            if token.len() != 32
                || !token
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
            {
                return Err(invalid());
            }
            Ok(())
        }
        "warp" => validate_warp(request, false),
        "warpPreview" => validate_warp(request, true),
        "warpCancel" => {
            object(request, &[])?;
            Ok(())
        }
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
mod macro_request_tests {
    use super::{request_script, validate_macro_script, validate_request, MAX_REQUEST_BYTES};
    use serde_json::{json, Value};

    fn request() -> Value {
        json!({
            "settings": {
                "map":"prt_fild08", "targets":[4000], "radius":12,
                "minHpPercent":45, "loot":true, "route_randomWalk":0,
                "route_step":10, "route_avoidWalls":true,
                "route_randomWalk_maxRouteTime":75,
                "attackRouteMaxPathDistance":20, "attackMaxRouteTime":4
            },
            "script": {
                "version":1, "name":"Field supply", "durationSeconds":86400,
                "maxActions":1000, "maxSpend":2000,
                "rules":[{
                    "name":"Recover", "priority":-1000, "cooldownSeconds":0,
                    "maxRuns":1000,
                    "conditions":[{"field":"hpPercent","operator":"lt","value":65.5}],
                    "steps":[{"type":"useItem","itemId":501,"timeoutSeconds":120}]
                }]
            }
        })
    }

    #[test]
    fn shared_macro_script_corpus_matches_typescript() {
        let cases: Value =
            serde_json::from_str(include_str!("../../src/data/macro-script-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                validate_macro_script(&case["script"]).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn accepts_independent_and_combined_unlimited_macro_limits() {
        for mask in 0..8 {
            let mut value = request();
            for (index, path) in [
                "/script/durationSeconds",
                "/script/maxActions",
                "/script/rules/0/maxRuns",
            ]
            .into_iter()
            .enumerate()
            {
                if mask & (1 << index) != 0 {
                    *value.pointer_mut(path).unwrap() = json!(0);
                }
            }
            assert!(
                validate_request("macro", &value).is_ok(),
                "rejected limit combination {mask}"
            );
        }
    }

    #[test]
    fn unlimited_macro_limits_remain_required_bounded_integers() {
        for (path, maximum) in [
            ("/script/durationSeconds", 86_400),
            ("/script/maxActions", 1000),
            ("/script/rules/0/maxRuns", 1000),
        ] {
            for invalid in [
                json!(-1),
                json!(0.5),
                json!(null),
                json!("0"),
                json!(maximum + 1),
            ] {
                let mut value = request();
                *value.pointer_mut(path).unwrap() = invalid;
                assert!(
                    validate_request("macro", &value).is_err(),
                    "accepted {path} in {value}"
                );
            }
            let mut value = request();
            let (parent, key) = path.rsplit_once('/').unwrap();
            value
                .pointer_mut(parent)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(key);
            assert!(
                validate_request("macro", &value).is_err(),
                "accepted missing {path}"
            );
        }
    }

    #[test]
    fn unlimited_macro_preserves_finite_step_timeouts() {
        for step in [
            json!({"type":"farm","map":"prt_fild08","targets":[1],"timeoutSeconds":86400}),
            json!({"type":"travel","map":"prontera","timeoutSeconds":86400}),
            json!({"type":"buy","serviceId":"tool-dealer-buy","itemId":501,"quantity":1,"maxSpend":0,"timeoutSeconds":86400}),
            json!({"type":"store","serviceId":"kafra-south-storage","itemId":501,"quantity":1,"keep":0,"maxSpend":0,"timeoutSeconds":86400}),
            json!({"type":"useItem","itemId":501,"timeoutSeconds":120}),
            json!({"type":"skill","skillId":1,"level":1,"mode":"self","timeoutSeconds":120}),
        ] {
            let mut value = request();
            value["script"]["durationSeconds"] = json!(0);
            value["script"]["maxActions"] = json!(0);
            value["script"]["rules"][0]["maxRuns"] = json!(0);
            value["script"]["rules"][0]["steps"] = json!([step]);
            assert!(validate_request("macro", &value).is_ok());
            let maximum = value["script"]["rules"][0]["steps"][0]["timeoutSeconds"]
                .as_i64()
                .unwrap();
            for invalid in [
                json!(0),
                json!(-1),
                json!(0.5),
                json!(null),
                json!(maximum + 1),
            ] {
                let mut invalid_value = value.clone();
                invalid_value["script"]["rules"][0]["steps"][0]["timeoutSeconds"] = invalid;
                assert!(
                    validate_request("macro", &invalid_value).is_err(),
                    "accepted {invalid_value}"
                );
            }
            value["script"]["rules"][0]["steps"][0]
                .as_object_mut()
                .unwrap()
                .remove("timeoutSeconds");
            assert!(validate_request("macro", &value).is_err());
        }
    }

    #[test]
    fn unlimited_macro_preserves_zero_spending_budget() {
        let mut value = request();
        value["script"]["durationSeconds"] = json!(0);
        value["script"]["maxActions"] = json!(0);
        value["script"]["maxSpend"] = json!(0);
        value["script"]["rules"][0]["maxRuns"] = json!(0);
        value["script"]["rules"][0]["steps"] = json!([{
            "type":"buy","serviceId":"tool-dealer-buy","itemId":501,
            "quantity":1,"maxSpend":0,"timeoutSeconds":1
        }]);
        assert!(validate_request("macro", &value).is_ok());
        value["script"]["rules"][0]["steps"][0]["maxSpend"] = json!(1);
        assert!(validate_request("macro", &value).is_err());
    }

    #[test]
    fn legacy_routine_still_requires_finite_execution_limits() {
        let routine = json!({
            "name":"Recover", "durationSeconds":86400, "maxActions":1000,
            "rules":[{
                "name":"Potion", "priority":0, "cooldownSeconds":0, "maxRuns":1000,
                "conditions":[{"field":"hpPercent","operator":"lt","value":65}],
                "action":{"type":"useItem","itemId":501}
            }]
        });
        assert!(validate_request("routine", &routine).is_ok());
        for path in ["/durationSeconds", "/maxActions", "/rules/0/maxRuns"] {
            let mut value = routine.clone();
            *value.pointer_mut(path).unwrap() = json!(0);
            assert!(
                validate_request("routine", &value).is_err(),
                "accepted unlimited legacy {path}"
            );
        }
    }

    #[test]
    fn accepts_typed_steps_and_rejects_extra_or_missing_step_fields() {
        for step in [
            json!({"type":"farm","map":"prt_fild08","targets":[1,2147483647],"timeoutSeconds":86400}),
            json!({"type":"travel","map":"prontera","timeoutSeconds":1}),
            json!({"type":"buy","serviceId":"tool-dealer-buy","itemId":2147483647,"quantity":100000,"maxSpend":2000,"timeoutSeconds":86400}),
            json!({"type":"store","serviceId":"kafra-south-storage","itemId":501,"quantity":1,"keep":100000,"maxSpend":0,"timeoutSeconds":1}),
            json!({"type":"useItem","itemId":2147483647,"timeoutSeconds":120}),
            json!({"type":"skill","skillId":32767,"level":10,"mode":"self","timeoutSeconds":120}),
            json!({"type":"skill","skillId":255,"level":1,"mode":"target","timeoutSeconds":1}),
        ] {
            let mut value = request();
            value["script"]["rules"][0]["steps"] = json!([step]);
            assert!(
                validate_request("macro", &value).is_ok(),
                "rejected {value}"
            );
            let keys: Vec<String> = value["script"]["rules"][0]["steps"][0]
                .as_object()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            for key in keys {
                let mut missing = value.clone();
                missing["script"]["rules"][0]["steps"][0]
                    .as_object_mut()
                    .unwrap()
                    .remove(&key);
                assert!(
                    validate_request("macro", &missing).is_err(),
                    "missing {key}"
                );
            }
            value["script"]["rules"][0]["steps"][0]["unknown"] = json!(true);
            assert!(validate_request("macro", &value).is_err());
        }
    }

    #[test]
    fn denies_unbounded_steps_service_overrides_and_manual_warp() {
        for step in [
            json!({"type":"farm","map":"prt_fild08","targets":[],"timeoutSeconds":1}),
            json!({"type":"farm","map":"prt_fild08","targets":[1,1],"timeoutSeconds":1}),
            json!({"type":"farm","map":"prt_fild08","targets":[0],"timeoutSeconds":1}),
            json!({"type":"farm","map":"prt_fild08","targets":vec![1;65],"timeoutSeconds":1}),
            json!({"type":"travel","map":"../prontera","timeoutSeconds":1}),
            json!({"type":"travel","map":"prontera","timeoutSeconds":86401}),
            json!({"type":"buy","serviceId":"tool-dealer-sell","itemId":501,"quantity":1,"maxSpend":0,"timeoutSeconds":1}),
            json!({"type":"buy","serviceId":"kafra-south-storage","itemId":501,"quantity":1,"maxSpend":0,"timeoutSeconds":1}),
            json!({"type":"buy","serviceId":"trader.prt-fild05.tool-dealer.buy.v1","itemId":501,"quantity":1,"maxSpend":0,"timeoutSeconds":1}),
            json!({"type":"buy","serviceId":"tool-dealer-buy","itemId":501,"quantity":1,"maxSpend":2001,"timeoutSeconds":1}),
            json!({"type":"store","serviceId":"tool-dealer-buy","itemId":501,"quantity":1,"keep":0,"maxSpend":0,"timeoutSeconds":1}),
            json!({"type":"store","serviceId":"kafra-south-storage","itemId":501,"quantity":100001,"keep":0,"maxSpend":0,"timeoutSeconds":1}),
            json!({"type":"store","serviceId":"kafra-south-storage","itemId":501,"quantity":1,"keep":-1,"maxSpend":0,"timeoutSeconds":1}),
            json!({"type":"useItem","itemId":0,"timeoutSeconds":1}),
            json!({"type":"useItem","itemId":501,"timeoutSeconds":121}),
            json!({"type":"skill","skillId":256,"level":1,"mode":"target","timeoutSeconds":1}),
            json!({"type":"skill","skillId":55,"level":1,"mode":"self","timeoutSeconds":1}),
            json!({"type":"skill","skillId":55,"level":1,"mode":"target","timeoutSeconds":1}),
            json!({"type":"skill","skillId":1,"level":11,"mode":"self","timeoutSeconds":1}),
            json!({"type":"skill","skillId":1,"level":1,"mode":"self","timeoutSeconds":121}),
            json!({"type":"skill","skillId":1,"level":1,"mode":"ground","timeoutSeconds":1}),
            json!({"type":"wait","timeoutSeconds":1}),
            json!({"type":"command","action":{"type":"respawn"},"timeoutSeconds":1}),
        ] {
            let mut value = request();
            value["script"]["rules"][0]["steps"] = json!([step]);
            assert!(
                validate_request("macro", &value).is_err(),
                "accepted {value}"
            );
        }
        let mut value = request();
        value["script"]["rules"][0]["steps"] = json!([{
            "type":"buy","serviceId":"tool-dealer-buy","itemId":501,
            "quantity":1,"maxSpend":0,"timeoutSeconds":1,
            "service":{"workflow":{"steps":[{"type":"option","index":2}]}}
        }]);
        assert!(validate_request("macro", &value).is_err());
    }

    #[test]
    fn enforces_script_limits_exact_shapes_and_normal_start_settings() {
        assert!(validate_request("macro", &request()).is_ok());
        for (path, invalid) in [
            ("/script/version", json!(2)),
            ("/script/name", json!(" ")),
            ("/script/name", json!("x".repeat(65))),
            ("/script/durationSeconds", json!(86401)),
            ("/script/maxActions", json!(1001)),
            ("/script/maxSpend", json!(2000000001_i64)),
            ("/script/rules", json!([])),
            ("/script/rules/0/priority", json!(-1001)),
            ("/script/rules/0/cooldownSeconds", json!(86401)),
            ("/script/rules/0/maxRuns", json!(-1)),
            ("/script/rules/0/conditions", json!([])),
            ("/script/rules/0/steps", json!([])),
            ("/settings", json!(null)),
            ("/settings/map", json!("unknown_map")),
            ("/settings/targets", json!([])),
            ("/settings/radius", json!(21)),
        ] {
            let mut value = request();
            *value.pointer_mut(path).unwrap() = invalid;
            assert!(
                validate_request("macro", &value).is_err(),
                "accepted {value}"
            );
        }
        for path in [
            "",
            "/script",
            "/script/rules/0",
            "/script/rules/0/conditions/0",
            "/settings",
        ] {
            let mut value = request();
            value
                .pointer_mut(path)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert("unknown".into(), json!(true));
            assert!(validate_request("macro", &value).is_err());
            let object = value.pointer_mut(path).unwrap().as_object_mut().unwrap();
            object.remove("unknown");
            let key = object.keys().next().unwrap().clone();
            object.remove(&key);
            assert!(
                validate_request("macro", &value).is_err(),
                "missing {path}/{key}"
            );
        }
        let mut value = request();
        let rule = value["script"]["rules"][0].clone();
        value["script"]["rules"] = json!([rule.clone(), rule.clone()]);
        assert!(validate_request("macro", &value).is_err());
        value["script"]["rules"] = json!(vec![rule; 33]);
        assert!(validate_request("macro", &value).is_err());
        for key in ["conditions", "steps"] {
            let mut value = request();
            let entry = value["script"]["rules"][0][key][0].clone();
            value["script"]["rules"][0][key] = json!(vec![entry; 17]);
            assert!(validate_request("macro", &value).is_err());
        }
    }

    #[test]
    fn macro_and_legacy_routine_share_new_numeric_and_actor_predicates() {
        for (condition, valid) in [
            (json!({"field":"level","operator":"gte","value":1}), true),
            (
                json!({"field":"jobLevel","operator":"lte","value":1000}),
                true,
            ),
            (
                json!({"field":"weightPercent","operator":"lt","value":65.5}),
                true,
            ),
            (json!({"field":"level","operator":"eq","value":1.5}), false),
            (json!({"field":"jobLevel","operator":"eq","value":0}), false),
            (
                json!({"field":"weightPercent","operator":"eq","value":100.1}),
                false,
            ),
            (
                json!({"field":"actorCasting","actor":{"scope":"target"},"operator":"eq","value":false}),
                true,
            ),
            (
                json!({"field":"actorHpPercent","actor":{"scope":"candidate"},"operator":"gte","value":0}),
                false,
            ),
        ] {
            let mut value = request();
            value["script"]["rules"][0]["conditions"] = json!([condition]);
            assert_eq!(validate_request("macro", &value).is_ok(), valid);
            let mut routine = value["script"].clone();
            let routine = routine.as_object_mut().unwrap();
            routine.remove("version");
            routine.remove("maxSpend");
            let rule = routine["rules"][0].as_object_mut().unwrap();
            rule.remove("steps");
            rule.insert("action".into(), json!({"type":"useItem","itemId":501}));
            assert_eq!(validate_request("routine", &json!(routine)).is_ok(), valid);
        }
    }

    #[test]
    fn script_byte_budget_excludes_settings_and_counts_utf8() {
        let mut value = request();
        let mut rule = value["script"]["rules"][0].clone();
        rule["steps"] = json!(vec![
            json!({"type":"travel","map":"x".repeat(64),"timeoutSeconds":86400});
            16
        ]);
        value["script"]["rules"] = json!((0..32)
            .map(|i| {
                let mut next = rule.clone();
                next["name"] = json!(format!("Rule {i}"));
                next
            })
            .collect::<Vec<_>>());
        // Fill only supported fields until one more condition crosses the cap.
        let condition = json!({"field":"hpPercent","operator":"lt","value":65.5});
        'fill: for i in 0..32 {
            for _ in 1..16 {
                value["script"]["rules"][i]["conditions"]
                    .as_array_mut()
                    .unwrap()
                    .push(condition.clone());
                if serde_json::to_vec(&value["script"]).unwrap().len() > MAX_REQUEST_BYTES {
                    value["script"]["rules"][i]["conditions"]
                        .as_array_mut()
                        .unwrap()
                        .pop();
                    break 'fill;
                }
            }
        }
        assert!(serde_json::to_vec(&value).unwrap().len() > MAX_REQUEST_BYTES);
        assert!(validate_request("macro", &value).is_ok());
        value["script"]["name"] = json!("ก".repeat(64));
        assert!(serde_json::to_vec(&value["script"]).unwrap().len() > MAX_REQUEST_BYTES);
        assert!(validate_request("macro", &value).is_err());
    }

    #[test]
    fn wrapper_and_settings_byte_budgets_are_bounded() {
        let mut value = request();
        value["settings"]["map"] = json!("x".repeat(MAX_REQUEST_BYTES));
        assert!(validate_request("macro", &value).is_err());
        value["settings"] = json!(null);
        value["unknown"] = json!("x".repeat(2 * MAX_REQUEST_BYTES));
        assert!(validate_request("macro", &value).is_err());
    }

    #[test]
    fn macro_dispatch_serializes_data_in_the_fixed_controller_call() {
        let mut value = request();
        value["script"]["name"] = json!("\"</script>\\window.alert(1)");
        let encoded = serde_json::to_string(&value).unwrap();
        assert_eq!(
            request_script("macro", &value).unwrap(),
            format!("window.__RAYRAG__?.perform(\"macro\",{encoded})")
        );
        for mode in ["command", "workflow", "routine", "service"] {
            assert!(validate_request(mode, &value).is_err());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{validate_action, validate_request};
    use serde_json::{json, Value};
    #[test]
    fn warp_shared_schema_and_generic_bypass() {
        let cases: Value =
            serde_json::from_str(include_str!("../../src/data/warp-request-cases.json")).unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                validate_request(case["mode"].as_str().unwrap(), &case["request"]).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
        }
        for action in [
            json!({"type":"skill","mode":"ground","skillId":55,"level":4,"position":{"x":11,"y":10}}),
            json!({"type":"skill","mode":"self","skillId":55,"level":1}),
        ] {
            assert!(validate_request("command", &action).is_err());
            let routine = json!({"name":"No Warp","durationSeconds":10,"maxActions":1,"rules":[{"name":"Denied","priority":0,"cooldownSeconds":1,"maxRuns":1,"conditions":[{"field":"hpPercent","operator":"lt","value":100}],"action":action}]});
            assert!(validate_request("routine", &routine).is_err());
        }
    }
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
    use super::{
        request_script, validate_action, validate_actor_predicate, validate_actor_predicate_for,
        validate_request,
    };
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

    #[test]
    fn workflow_supports_combined_recovery_and_existing_stock_guards() {
        let mut value = workflow();
        value["minStock"] = json!((1..=160)
            .map(|id| json!({"itemId": id, "count": 1}))
            .collect::<Vec<_>>());
        assert!(validate_request("workflow", &value).is_ok());
        value["minStock"]
            .as_array_mut()
            .unwrap()
            .push(json!({"itemId": 161, "count": 1}));
        assert!(validate_request("workflow", &value).is_err());
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
    fn resource_predicates_share_the_typescript_schema() {
        let cases: Value = serde_json::from_str(include_str!(
            "../../src/data/actor-resource-condition-cases.json"
        ))
        .unwrap();
        for case in cases.as_array().unwrap() {
            assert_eq!(
                validate_actor_predicate(&case["condition"]).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["condition"]
            );
            let mut value = routine();
            value["rules"][0]["conditions"] = json!([case["condition"]]);
            assert_eq!(
                validate_request("routine", &value).is_ok(),
                case["valid"].as_bool().unwrap()
            );
        }
        let candidate = json!({"field":"actorHpPercent","actor":{"scope":"candidate"},"operator":"gt","value":0});
        assert!(validate_actor_predicate_for(&candidate, true).is_ok());
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
    #[test]
    fn manual_targets_are_strict_and_command_only() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../src/data/manual-target-cases.json")).unwrap();
        for case in cases {
            let request = &case["request"];
            assert_eq!(
                validate_request("command", request).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            assert!(
                validate_action(request).is_err(),
                "manual target cannot be a routine action"
            );
            assert!(validate_request("workflow", request).is_err());
            assert!(validate_request("routine", request).is_err());
            assert!(validate_request("service", request).is_err());
        }
    }
    #[test]
    fn manual_target_envelope_retains_the_native_size_limit() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../../src/data/manual-target-cases.json")).unwrap();
        let mut request = cases[0]["request"].clone();
        request["policy"]["monsterRules"]=serde_json::Value::Array((0..64).map(|i|json!({"classId":4000+i,"action":"attack","priority":0,"conditions":(0..16).map(|_|json!({"field":"actorStatus","actor":{"scope":"actor","world":"12345678-1234-1234-1234-123456789abc","id":2,"incarnation":2},"statusId":1,"operator":"eq","value":true})).collect::<Vec<_>>()})).collect());
        assert!(serde_json::to_vec(&request).unwrap().len() > 65536);
        assert!(validate_request("command", &request).is_err());
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

#[cfg(test)]
mod refine_tests {
    use super::{request_script, validate_request};
    use serde_json::{json, Value};
    #[test]
    fn shares_strict_refine_corpus_and_excludes_automatic_documents() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../src/data/refine-request-cases.json")).unwrap();
        for case in cases {
            let mode = case["mode"].as_str().unwrap();
            let request = &case["request"];
            assert_eq!(
                validate_request(mode, request).is_ok(),
                case["valid"].as_bool().unwrap(),
                "{}",
                case["name"]
            );
            for other in ["command", "workflow", "routine", "service", "social"] {
                assert!(validate_request(other, request).is_err());
            }
            let routine = json!({"name":"No refine automation","durationSeconds":10,"maxActions":1,"rules":[{"name":"Rejected","priority":0,"cooldownSeconds":1,"maxRuns":1,"conditions":[{"field":"hpPercent","operator":"lt","value":100}],"action":request}]});
            assert!(validate_request("routine", &routine).is_err());
            if case["valid"].as_bool().unwrap() {
                assert!(request_script(mode, request)
                    .unwrap()
                    .starts_with("window.__RAYRAG__?.perform("));
            }
        }
    }
    #[test]
    fn rejects_oversized_otherwise_valid_refine_protection_policy() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../src/data/refine-request-cases.json")).unwrap();
        let mut request = cases[0]["request"].clone();
        request["policy"]["combat"]["rules"] = json!((0..64).map(|i| json!({"classId":4000+i,"action":"attack","priority":0,"conditions":(0..16).map(|_|json!({"field":"actorStatus","actor":{"scope":"self"},"statusId":6,"operator":"eq","value":false})).collect::<Vec<_>>()})).collect::<Vec<_>>());
        assert!(crate::automation::validate_manual_protection_policy(&request["policy"]).is_ok());
        assert!(serde_json::to_vec(&request).unwrap().len() > 65_536);
        assert!(validate_request("refinePreview", &request).is_err());
    }
}
