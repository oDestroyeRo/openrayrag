use rmcp::model::{Tool, ToolAnnotations};
use serde_json::{json, Map, Value};

pub const MAX_BODY_BYTES: usize = 1_600_000; // JSON escaping of the 256 KiB authoring limit.
pub const MAX_OUTPUT_BYTES: usize = 262_144;
pub const MAX_SCRIPT_BYTES: usize = 262_144;
pub const MAX_CONCURRENT: usize = 4;

pub fn tool(name: &str) -> Option<Tool> {
    let description = match name {
        "get_status" => "Read run intent, connection and observed gameplay status with explicit freshness.",
        "get_settings" => "Read the retained settings form separately from observed active-run settings.",
        "list_profiles" => "Read detached, validated saved profiles. Never apply a profile.",
        "validate_script" => "Validate and preview Bot script data without saving or executing it. Legacy JSON uses the retained form as its baseline.",
        _ => return None,
    };
    let schema = if name == "validate_script" {
        json!({"type":"object","properties":{"script":{"type":"string","maxLength":MAX_SCRIPT_BYTES}},"required":["script"],"additionalProperties":false})
    } else {
        json!({"type":"object","properties":{},"additionalProperties":false})
    };
    let mut tool = Tool::new(name.to_owned(), description, schema.as_object()?.clone());
    tool.annotations = Some(
        ToolAnnotations::new()
            .read_only(true)
            .destructive(false)
            .idempotent(true)
            .open_world(false),
    );
    Some(tool)
}

pub fn arguments_valid(name: &str, args: &Map<String, Value>) -> bool {
    if name == "validate_script" {
        args.len() == 1
            && args
                .get("script")
                .and_then(Value::as_str)
                .is_some_and(|script| script.len() <= MAX_SCRIPT_BYTES)
    } else {
        tool(name).is_some() && args.is_empty()
    }
}

/// Compare the complete bearer header without early exit on a matching prefix.
pub fn authenticated(header: &[u8], token: &str) -> bool {
    let expected = format!("Bearer {token}");
    if header.len() != expected.len() {
        return false;
    }
    header
        .iter()
        .zip(expected.bytes())
        .fold(0_u8, |different, (a, b)| different | (a ^ b))
        == 0
}

pub fn retired_result(name: &str, mut result: Value, generation: u64) -> Value {
    result["observation"] = json!({"state":"unavailable","runtimeGeneration":generation,"observedAt":null,"sequence":null,"ageMs":null,"staleAfterMs":7000});
    if name == "get_settings" {
        result["activeRun"] = Value::Null;
        result["unavailable"] = json!(["activeRun"]);
    } else {
        let retained = result
            .pointer("/run/retainedFieldRequested")
            .and_then(Value::as_bool)
            == Some(true)
            || result
                .pointer("/run/updateContinuationPending")
                .and_then(Value::as_bool)
                == Some(true);
        result["run"]["requested"] = if retained {
            Value::Bool(true)
        } else {
            Value::Null
        };
        result["connection"] = json!({"mode":null,"connected":null,"ready":null});
        result["character"] = Value::Null;
        result["map"] = Value::Null;
        for key in [
            "state",
            "reason",
            "elapsedSeconds",
            "kills",
            "pickups",
            "configuredLimits",
        ] {
            result["run"][key] = Value::Null;
        }
        result["receipts"] = json!({"action":null,"settingsApply":null});
        result["unavailable"] = json!([
            "gameplay",
            "activeRunSettings",
            "actionReceipts",
            "remainingRunBudgets"
        ]);
    }
    result
}
