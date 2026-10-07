use rmcp::model::{Tool, ToolAnnotations};
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

pub const MAX_BODY_BYTES: usize = 1_600_000; // JSON escaping of the 256 KiB authoring limit.
pub const MAX_OUTPUT_BYTES: usize = 262_144;
pub const MAX_SCRIPT_BYTES: usize = 262_144;
pub const MAX_CONCURRENT: usize = 4;

pub const TOOL_NAMES: [&str; 23] = [
    "get_status",
    "get_settings",
    "list_profiles",
    "validate_script",
    "get_client_state",
    "get_script",
    "list_services",
    "export_profile",
    "export_service",
    "get_operation",
    "preview_bot",
    "set_settings",
    "set_script",
    "profile",
    "service_definition",
    "connect",
    "disconnect",
    "start_bot",
    "stop_bot",
    "apply_settings",
    "set_reconnect",
    "forget_login",
    "client_action",
];
pub fn mutating(name: &str) -> bool {
    TOOL_NAMES[11..].contains(&name)
}
pub fn request_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_-".contains(&b))
}
fn integer(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_u64)
        .is_some_and(|n| n <= 9_007_199_254_740_991)
}
pub fn tool(name: &str) -> Option<Tool> {
    let description = match name {
        "get_status" => "Read run intent, connection and observed gameplay status with explicit freshness.",
        "get_settings" => "Read the settings form separately from active-run settings, including draft revision.",
        "list_profiles" => "Read detached, validated saved profiles.",
        "validate_script" => "Validate and preview Bot script data without saving or executing it.",
        "get_client_state" => "Read client state, connection and safe account metadata without credentials.",
        "get_script" => "Read the retained Bot script and draft revision.",
        "list_services" => "List validated saved service definitions.",
        "export_profile" => "Export a validated profile document by identity.",
        "export_service" => "Export a validated service definition document by identity.",
        "preview_bot" => "Preview an existing bot plan without saving, starting or sending any actions. Missing or stale observations are explicit.",
        "get_operation" => "Read a retained operation receipt. Unresolved means do not retry with a new identity.",
        "set_settings" => "Replace and save the settings draft through the existing form owner. Does not start the bot.",
        "set_script" => "Validate and save the Bot script through the existing owner. Does not start the bot.",
        "profile" => "Save, remove, import, select or apply a profile through the existing profile owner.",
        "service_definition" => "Save, remove or import a service definition through the existing owner.",
        "connect" => "Connect using supplied or locally saved credentials through the existing login owner.",
        "disconnect" => "Disconnect the current client using the captured runtime generation.",
        "start_bot" => "Start the configured Form or Script with existing readiness and run protections.",
        "stop_bot" => "Stop bot intent and update continuation. Available independently of stale generations.",
        "apply_settings" => "Apply eligible settings to the active run without renewing limits or unresolved receipts.",
        "set_reconnect" => "Change the current session reconnect preference without starting the bot.",
        "forget_login" => "Forget the saved local login through the credential owner.",
        "client_action" => "Submit a validated existing client action with its receipt and allowance protections.",
        _ => return None,
    };
    let mut properties = Map::new();
    let mut required = Vec::new();
    let mut add = |key: &str, schema: Value, mandatory: bool| {
        properties.insert(key.to_owned(), schema);
        if mandatory {
            required.push(key.to_owned());
        }
    };
    let id = json!({"type":"string","minLength":1,"maxLength":64,"pattern":"^[A-Za-z0-9_-]+$"});
    let revision = json!({"type":"integer","minimum":0,"maximum":9_007_199_254_740_991_u64});
    if mutating(name) {
        add("requestId", id.clone(), true);
    }
    if matches!(
        name,
        "set_settings"
            | "set_script"
            | "profile"
            | "service_definition"
            | "connect"
            | "start_bot"
            | "apply_settings"
            | "set_reconnect"
            | "forget_login"
    ) {
        add("expectedDraftRevision", revision.clone(), true);
    }
    if matches!(
        name,
        "disconnect" | "start_bot" | "apply_settings" | "client_action"
    ) {
        add("expectedGeneration", revision, true);
    }
    match name {
        "validate_script" | "set_script" => add(
            "script",
            json!({"type":"string","maxLength":MAX_SCRIPT_BYTES}),
            true,
        ),
        "export_profile" | "export_service" => add("id", id, true),
        "get_operation" => add("requestId", id, true),
        "set_settings" => add("settings", json!({"type":"object"}), true),
        "profile" => {
            add(
                "operation",
                json!({"type":"string","enum":["save","remove","import","apply","select"]}),
                true,
            );
            add("id", id, false);
            add(
                "name",
                json!({"type":"string","minLength":1,"maxLength":256}),
                false,
            );
            add(
                "document",
                json!({"type":"string","maxLength":MAX_SCRIPT_BYTES}),
                false,
            );
        }
        "service_definition" => {
            add(
                "operation",
                json!({"type":"string","enum":["save","remove","import"]}),
                true,
            );
            add("id", id, false);
            add("definition", json!({"type":"object"}), false);
            add(
                "document",
                json!({"type":"string","maxLength":MAX_SCRIPT_BYTES}),
                false,
            );
        }
        "preview_bot" => {
            add(
                "kind",
                json!({"type":"string","enum":["workflow","routine","macro","route","service","disposition","supply"]}),
                true,
            );
            add("request", json!({"type":"object"}), true);
        }
        "connect" => {
            for key in ["username", "password"] {
                add(
                    key,
                    json!({"type":"string","minLength":1,"maxLength":256}),
                    false,
                );
            }
            add(
                "characterSlot",
                json!({"type":"integer","minimum":0,"maximum":2}),
                false,
            );
            add(
                "mode",
                json!({"type":"string","enum":["botOnly","gameClient"]}),
                false,
            );
            for key in ["remember", "autoLogin"] {
                add(key, json!({"type":"boolean"}), false);
            }
        }
        "set_reconnect" => add("enabled", json!({"type":"boolean"}), true),
        "client_action" => {
            add(
                "action",
                json!({"type":"string","enum":["command","workflow","routine","macro","service","social","memo","socketPreview","socket","warpPreview","warp","warpCancel","refinePreview","refine","refineAdvance"]}),
                true,
            );
            add("request", json!({"type":"object"}), true);
        }
        _ => {}
    }
    let mut schema = json!({"type":"object","properties":properties,"required":required,"additionalProperties":false});
    // Advertise the same operation-specific admission that the native boundary enforces.
    if name == "profile" {
        schema["oneOf"] = json!([
            {"properties":{"operation":{"const":"save"}},"required":["name"],"not":{"required":["document"]}},
            {"properties":{"operation":{"enum":["remove","apply","select"]}},"required":["id"],"not":{"anyOf":[{"required":["name"]},{"required":["document"]}]}},
            {"properties":{"operation":{"const":"import"}},"required":["document"],"not":{"anyOf":[{"required":["id"]},{"required":["name"]}]}}
        ]);
    } else if name == "service_definition" {
        schema["oneOf"] = json!([
            {"properties":{"operation":{"const":"save"}},"required":["definition"],"not":{"required":["document"]}},
            {"properties":{"operation":{"const":"remove"}},"required":["id"],"not":{"anyOf":[{"required":["definition"]},{"required":["document"]}]}},
            {"properties":{"operation":{"const":"import"}},"required":["document"],"not":{"anyOf":[{"required":["id"]},{"required":["definition"]}]}}
        ]);
    } else if name == "connect" {
        schema["dependentRequired"] = json!({"username":["password"],"password":["username"]});
    } else if name == "preview_bot" {
        schema["oneOf"] = json!([
            {"properties":{"kind":{"enum":["workflow","routine"]},"request":{"type":"object","properties":{"spec":{"type":"object"}},"required":["spec"],"additionalProperties":false}}},
            {"properties":{"kind":{"const":"macro"},"request":{"type":"object","properties":{"script":{"type":"string","maxLength":MAX_SCRIPT_BYTES}},"required":["script"],"additionalProperties":false}}},
            {"properties":{"kind":{"const":"route"},"request":{"type":"object","properties":{"destinationMap":{"type":"string","minLength":1,"maxLength":128}},"additionalProperties":false}}},
            {"properties":{"kind":{"const":"service"},"request":{"type":"object","properties":{"definition":{"type":"object"}},"required":["definition"],"additionalProperties":false}}},
            {"properties":{"kind":{"const":"disposition"},"request":{"type":"object","properties":{"policy":{"type":"object"}},"additionalProperties":false}}},
            {"properties":{"kind":{"const":"supply"},"request":{"type":"object","properties":{},"additionalProperties":false}}}
        ]);
    }
    let mut tool = Tool::new(name.to_owned(), description, schema.as_object()?.clone());
    tool.annotations = Some(
        ToolAnnotations::new()
            .read_only(!mutating(name))
            .destructive(mutating(name))
            .idempotent(true)
            .open_world(matches!(
                name,
                "connect"
                    | "disconnect"
                    | "start_bot"
                    | "stop_bot"
                    | "apply_settings"
                    | "client_action"
            )),
    );
    Some(tool)
}

pub fn arguments_valid(name: &str, args: &Map<String, Value>) -> bool {
    let Some(tool) = tool(name) else {
        return false;
    };
    let schema = &tool.input_schema;
    let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
        return false;
    };
    if args.keys().any(|key| !properties.contains_key(key)) {
        return false;
    }
    if schema
        .get("required")
        .and_then(Value::as_array)
        .is_some_and(|required| {
            required
                .iter()
                .any(|key| !args.contains_key(key.as_str().unwrap_or("")))
        })
    {
        return false;
    }
    for (key, value) in args {
        let property = &properties[key];
        let valid = match property.get("type").and_then(Value::as_str) {
            Some("string") => value.as_str().is_some_and(|text| {
                let min = property
                    .get("minLength")
                    .and_then(Value::as_u64)
                    .unwrap_or(0) as usize;
                let max = property
                    .get("maxLength")
                    .and_then(Value::as_u64)
                    .unwrap_or(MAX_SCRIPT_BYTES as u64) as usize;
                text.len() >= min
                    && text.len() <= max
                    && (!matches!(key.as_str(), "id" | "requestId") || request_id(text))
            }),
            Some("integer") => {
                integer(Some(value))
                    && value.as_u64().is_some_and(|n| {
                        n <= property
                            .get("maximum")
                            .and_then(Value::as_u64)
                            .unwrap_or(u64::MAX)
                    })
            }
            Some("boolean") => value.is_boolean(),
            Some("object") => value.is_object(),
            _ => false,
        };
        if !valid
            || property
                .get("enum")
                .and_then(Value::as_array)
                .is_some_and(|values| !values.contains(value))
        {
            return false;
        }
    }
    match name {
        "profile" => match args.get("operation").and_then(Value::as_str) {
            Some("save") => args.contains_key("name") && !args.contains_key("document"),
            Some("import") => {
                args.contains_key("document")
                    && !args.contains_key("id")
                    && !args.contains_key("name")
            }
            Some("remove" | "apply" | "select") => {
                args.contains_key("id")
                    && !args.contains_key("name")
                    && !args.contains_key("document")
            }
            _ => false,
        },
        "service_definition" => match args.get("operation").and_then(Value::as_str) {
            Some("save") => args.contains_key("definition") && !args.contains_key("document"),
            Some("import") => {
                args.contains_key("document")
                    && !args.contains_key("definition")
                    && !args.contains_key("id")
            }
            Some("remove") => {
                args.contains_key("id")
                    && !args.contains_key("definition")
                    && !args.contains_key("document")
            }
            _ => false,
        },
        "preview_bot" => {
            let Some(request) = args.get("request").and_then(Value::as_object) else {
                return false;
            };
            match args.get("kind").and_then(Value::as_str) {
                Some("workflow" | "routine") => {
                    request.len() == 1 && request.get("spec").is_some_and(Value::is_object)
                }
                Some("macro") => {
                    request.len() == 1
                        && request
                            .get("script")
                            .and_then(Value::as_str)
                            .is_some_and(|script| script.len() <= MAX_SCRIPT_BYTES)
                }
                Some("route") => {
                    request.is_empty()
                        || request.len() == 1
                            && request
                                .get("destinationMap")
                                .and_then(Value::as_str)
                                .is_some_and(|map| !map.is_empty() && map.len() <= 128)
                }
                Some("service") => {
                    request.len() == 1 && request.get("definition").is_some_and(Value::is_object)
                }
                Some("disposition") => {
                    request.is_empty()
                        || request.len() == 1 && request.get("policy").is_some_and(Value::is_object)
                }
                Some("supply") => request.is_empty(),
                _ => false,
            }
        }
        "connect" => args.contains_key("username") == args.contains_key("password"),
        _ => true,
    }
}

/// Command grants are narrower than the main view's general UI authority.
pub fn effect_allowed(tool: &str, action: Option<&str>, effect: &str) -> bool {
    match effect {
        "save_current_form" => matches!(
            tool,
            "set_settings"
                | "set_script"
                | "profile"
                | "service_definition"
                | "connect"
                | "set_reconnect"
                | "forget_login"
        ),
        "login_game" => tool == "connect",
        "close_game" => tool == "disconnect",
        "forget_login" => tool == "forget_login",
        "update_cancel" => tool == "stop_bot",
        "control_bot:start" | "control_bot:macro" => {
            tool == "start_bot"
                || tool == "client_action"
                    && action == Some("macro")
                    && effect == "control_bot:macro"
        }
        "control_bot:stop" => tool == "stop_bot",
        "control_bot:apply" => tool == "apply_settings",
        effect => {
            tool == "client_action"
                && action.is_some_and(|action| effect.strip_prefix("control_bot:") == Some(action))
        }
    }
}

/// Fingerprints compare semantic JSON objects, independent of upstream map feature flags.
pub fn fingerprint(tool: &str, args: &Map<String, Value>) -> Result<[u8; 32], serde_json::Error> {
    fn canonical(value: &Value) -> Value {
        match value {
            Value::Object(values) => {
                let mut keys = values.keys().collect::<Vec<_>>();
                keys.sort_unstable();
                Value::Object(
                    keys.into_iter()
                        .map(|key| (key.clone(), canonical(&values[key])))
                        .collect(),
                )
            }
            Value::Array(values) => Value::Array(values.iter().map(canonical).collect()),
            value => value.clone(),
        }
    }
    let mut digest = Sha256::new();
    digest.update(tool.as_bytes());
    digest.update([0]);
    digest.update(serde_json::to_vec(&canonical(&Value::Object(
        args.clone(),
    )))?);
    Ok(digest.finalize().into())
}

/// Connection outcomes must not retain plaintext credential fields even if an owner misprojects them.
pub fn credential_free_result(result: Value) -> Value {
    match result {
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .filter(|(key, _)| {
                    !matches!(
                        key.to_ascii_lowercase().as_str(),
                        "password" | "credentials" | "token"
                    )
                })
                .map(|(key, value)| (key, credential_free_result(value)))
                .collect(),
        ),
        Value::Array(values) => {
            Value::Array(values.into_iter().map(credential_free_result).collect())
        }
        value => value,
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
    if name == "preview_bot" {
        return json!({"error":"The client runtime changed while preparing this preview. Read the current client state before requesting another preview.","observation":{"state":"unavailable","runtimeGeneration":generation}});
    }
    result["observation"] = json!({"state":"unavailable","runtimeGeneration":generation,"observedAt":null,"sequence":null,"ageMs":null,"staleAfterMs":7000});
    if name == "get_client_state" {
        result["gameplay"] = Value::Null;
        result["controls"] = Value::Null;
        result["unavailable"] = json!(["gameplay", "controls"]);
    } else if name == "get_settings" {
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
