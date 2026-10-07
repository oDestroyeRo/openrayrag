use super::*;
use rmcp::{
    model::{CallToolRequestParams, ClientConfig},
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    ServiceExt,
};
use serde_json::json;

struct Fixture {
    core: Arc<Core>,
    connection: Connection,
    generation: Arc<AtomicU64>,
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.core.shutdown();
    }
}
impl Fixture {
    async fn new(handler: impl Fn(Query, &Core) + Send + Sync + 'static) -> Self {
        Self::with_control(false, handler).await
    }
    async fn with_control(
        control: bool,
        handler: impl Fn(Query, &Core) + Send + Sync + 'static,
    ) -> Self {
        let _ = rustls::crypto::ring::default_provider().install_default();
        let core = Arc::new(Core::default());
        let replies = core.clone();
        let generation = Arc::new(AtomicU64::new(2));
        let runtime = generation.clone();
        let connection = start(
            core.clone(),
            Arc::new(move |query| {
                handler(query, &replies);
                Ok(())
            }),
            Arc::new(move || Some(runtime.load(Ordering::SeqCst))),
            control,
        )
        .await
        .unwrap();
        Self {
            core,
            connection,
            generation,
        }
    }
    fn transport(&self) -> StreamableHttpClientTransport<reqwest::Client> {
        StreamableHttpClientTransport::from_config(
            StreamableHttpClientTransportConfig::with_uri(self.connection.endpoint.clone())
                .auth_header(self.connection.token.clone()),
        )
    }
    fn post(&self, body: Value) -> reqwest::RequestBuilder {
        reqwest::Client::new()
            .post(&self.connection.endpoint)
            .bearer_auth(&self.connection.token)
            .header("accept", "application/json, text/event-stream")
            .header("mcp-protocol-version", "2025-11-25")
            .json(&body)
    }
}
fn call(id: usize, name: &str) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":{}}})
}

#[tokio::test]
async fn official_external_client_discovers_full_catalog_and_calls_existing_read_tools() {
    let fixture = Fixture::new(|query, core| {
        core.reply(
            &query.id,
            query.runtime_generation,
            json!({"tool":query.tool,"arguments":query.arguments}),
        )
        .unwrap();
    })
    .await;
    let client = ClientConfig::default()
        .serve(fixture.transport())
        .await
        .unwrap();
    let tools = client.list_all_tools().await.unwrap();
    assert_eq!(tools.len(), mcp_logic::TOOL_NAMES.len());
    assert!(tools
        .iter()
        .all(|tool| tool.annotations.as_ref().unwrap().read_only_hint
            == Some(!mcp_logic::mutating(tool.name.as_ref()))));
    for name in [
        "get_status",
        "get_settings",
        "list_profiles",
        "validate_script",
    ] {
        let arguments = if name == "validate_script" {
            json!({"script":"script \"Fixture\""})
        } else {
            json!({})
        };
        let response = client
            .call_tool(
                CallToolRequestParams::new(name)
                    .with_arguments(arguments.as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        let result = response;
        assert_ne!(result.is_error, Some(true));
        assert_eq!(result.structured_content.unwrap()["tool"], name);
    }
    assert!(fixture.core.requests.lock().unwrap().pending.is_empty());
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn legacy_initialize_and_auth_origin_host_and_input_limits() {
    let fixture = Fixture::new(|query, core| {
        core.reply(&query.id, query.runtime_generation, json!({"ok":true}))
            .unwrap();
    })
    .await;
    let http = reqwest::Client::new();
    for method in [
        reqwest::Method::POST,
        reqwest::Method::GET,
        reqwest::Method::DELETE,
    ] {
        assert_eq!(
            http.request(method, &fixture.connection.endpoint)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        fixture
            .post(call(1, "get_status"))
            .header("authorization", "Bearer wrong")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    for origin in [
        "https://untrusted.example",
        "null",
        "http://127.0.0.1:1",
        "http://127.0.0.1.evil:123",
    ] {
        assert_eq!(
            fixture
                .post(call(1, "get_status"))
                .header("origin", origin)
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::FORBIDDEN
        );
    }
    assert_eq!(
        fixture
            .post(call(1, "get_status"))
            .header("host", "attacker.example")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    let origin = fixture.connection.endpoint.trim_end_matches("/mcp");
    assert_eq!(
        fixture
            .post(call(1, "get_status"))
            .header("origin", origin)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    let initialized: Value = fixture.post(json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"loopback-fixture","version":"1"}}})).send().await.unwrap().json().await.unwrap();
    assert_eq!(initialized["result"]["protocolVersion"], "2025-11-25");
    let invalid: Value = fixture.post(json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"validate_script","arguments":{"script":"x".repeat(mcp_logic::MAX_SCRIPT_BYTES+1)}}})).send().await.unwrap().json().await.unwrap();
    assert!(invalid.get("error").is_some());
    let unknown: Value = fixture
        .post(call(1, "start"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(unknown.get("error").is_some());
    let chunks = futures_util::stream::iter(vec![
        Ok::<_, std::io::Error>(vec![b' '; MAX_BODY_BYTES]),
        Ok(vec![b' '; 1]),
    ]);
    let oversized = http
        .post(&fixture.connection.endpoint)
        .bearer_auth(&fixture.connection.token)
        .header("accept", "application/json, text/event-stream")
        .header("content-type", "application/json")
        .body(reqwest::Body::wrap_stream(chunks))
        .send()
        .await
        .unwrap();
    assert_eq!(oversized.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(fixture.core.requests.lock().unwrap().pending.is_empty());
}

#[tokio::test]
async fn runtime_replacement_and_oversized_replies_are_not_exposed() {
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let fixture = Fixture::new(move |query, _| {
        sent.send(query).unwrap();
    })
    .await;
    let request = fixture.post(call(1, "get_status")).send();
    let complete = async {
        let query = received.recv().await.unwrap();
        fixture.generation.store(3, Ordering::SeqCst);
        fixture.core.reply(&query.id, query.runtime_generation, json!({"observation":{"state":"current"},"character":{"name":"old character"},"run":{"requested":true},"map":"old map","receipts":{}})).unwrap();
    };
    let (response, _) = tokio::join!(request, complete);
    let response: Value = response.unwrap().json().await.unwrap();
    assert_eq!(
        response["result"]["structuredContent"]["character"],
        Value::Null
    );
    assert_eq!(
        response["result"]["structuredContent"]["observation"]["state"],
        "unavailable"
    );
    let request = fixture.post(call(2, "list_profiles")).send();
    let complete = async {
        let query = received.recv().await.unwrap();
        fixture
            .core
            .reply(
                &query.id,
                query.runtime_generation,
                json!({"profiles":"private-fixture".repeat(MAX_OUTPUT_BYTES)}),
            )
            .unwrap();
    };
    let (response, _) = tokio::join!(request, complete);
    let response = response.unwrap().text().await.unwrap();
    assert!(response.contains("output limit"));
    assert!(!response.contains("private-fixture"));
    assert!(fixture.core.requests.lock().unwrap().pending.is_empty());
}

#[tokio::test]
async fn concurrent_reads_disable_cleanup_and_reenable_revoke_access() {
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let fixture = Fixture::new(move |query, _| {
        sent.send(query).unwrap();
    })
    .await;
    let requests = (0..MAX_CONCURRENT)
        .map(|id| fixture.post(call(id, "get_status")).send())
        .collect::<Vec<_>>();
    let retire = async {
        let mut queries = Vec::new();
        for _ in 0..MAX_CONCURRENT {
            queries.push(received.recv().await.unwrap());
        }
        assert_eq!(
            fixture.core.requests.lock().unwrap().pending.len(),
            MAX_CONCURRENT
        );
        assert_eq!(
            fixture
                .post(call(99, "get_status"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::TOO_MANY_REQUESTS
        );
        fixture.core.shutdown();
        assert!(fixture.core.requests.lock().unwrap().pending.is_empty());
        for query in queries {
            assert!(fixture
                .core
                .reply(&query.id, query.runtime_generation, json!({"late":true}))
                .is_err());
        }
    };
    let (_, _) = tokio::join!(futures_util::future::join_all(requests), retire);
    let reopened = start(
        fixture.core.clone(),
        Arc::new(|_| Ok(())),
        Arc::new(|| Some(2)),
        false,
    )
    .await
    .unwrap();
    assert_ne!(fixture.connection.token, reopened.token);
    let status = reqwest::Client::new()
        .get(&reopened.endpoint)
        .bearer_auth(&fixture.connection.token)
        .send()
        .await
        .unwrap()
        .status();
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn abandoned_queries_have_a_bounded_deadline_and_cleanup() {
    let fixture = Fixture::new(|_, _| {}).await;
    let started = std::time::Instant::now();
    let response = tokio::time::timeout(
        DEADLINE + Duration::from_secs(2),
        fixture.post(call(1, "get_status")).send(),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(started.elapsed() >= DEADLINE - Duration::from_millis(100));
    if response.status() == StatusCode::OK {
        let result: Value = response.json().await.unwrap();
        assert_eq!(result["result"]["isError"], true);
        assert!(result.to_string().contains("timed out"));
    } else {
        assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
    }
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(fixture.core.requests.lock().unwrap().pending.is_empty());
}

#[tokio::test]
async fn external_client_cancellation_retires_pending_query() {
    use rmcp::{
        model::{CallToolRequest, ClientRequest},
        service::PeerRequestOptions,
    };
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let fixture = Fixture::new(move |query, _| {
        sent.send(query).unwrap();
    })
    .await;
    let client = ClientConfig::default()
        .serve(fixture.transport())
        .await
        .unwrap();
    let handle = client
        .send_cancellable_request(
            ClientRequest::CallToolRequest(CallToolRequest::new(CallToolRequestParams::new(
                "get_status",
            ))),
            PeerRequestOptions::no_options(),
        )
        .await
        .unwrap();
    let query = received.recv().await.unwrap();
    handle
        .cancel(Some("fixture cancellation".into()))
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        while !fixture.core.requests.lock().unwrap().pending.is_empty() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .unwrap();
    assert!(fixture
        .core
        .reply(&query.id, query.runtime_generation, json!({"late":true}))
        .is_err());
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn stalled_authenticated_body_hits_http_deadline() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let fixture = Fixture::new(|_, _| {}).await;
    let address = fixture
        .connection
        .endpoint
        .trim_start_matches("http://")
        .trim_end_matches("/mcp");
    let mut socket = tokio::net::TcpStream::connect(address).await.unwrap();
    let headers = format!("POST /mcp HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nContent-Length: 100\r\n\r\n{{", fixture.connection.token);
    socket.write_all(headers.as_bytes()).await.unwrap();
    let mut response = [0_u8; 1024];
    let count = tokio::time::timeout(
        DEADLINE + Duration::from_secs(2),
        socket.read(&mut response),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(std::str::from_utf8(&response[..count])
        .unwrap()
        .starts_with("HTTP/1.1 408"));
    assert!(fixture.core.requests.lock().unwrap().pending.is_empty());
}

#[test]
fn native_replacement_recomputes_intent_only_from_retained_main_owners() {
    let old = json!({"run":{"requested":true,"retainedFieldRequested":false,"updateContinuationPending":false}});
    assert_eq!(
        mcp_logic::retired_result("get_status", old, 3)["run"]["requested"],
        Value::Null
    );
    for key in ["retainedFieldRequested", "updateContinuationPending"] {
        let mut old = json!({"run":{"requested":false,"retainedFieldRequested":false,"updateContinuationPending":false}});
        old["run"][key] = json!(true);
        assert_eq!(
            mcp_logic::retired_result("get_status", old, 3)["run"]["requested"],
            json!(true)
        );
    }
}

#[test]
fn mcp_commands_are_exclusive_to_local_main_view_capabilities() {
    for document in [
        include_str!("../../capabilities/controller.json"),
        include_str!("../../capabilities/ci-smoke.json"),
    ] {
        let capability: Value = serde_json::from_str(document).unwrap();
        assert!(capability.get("windows").is_none());
        assert_eq!(capability["webviews"], json!(["main"]));
        for permission in [
            "allow-mcp-set-enabled",
            "allow-mcp-reply",
            "allow-mcp-claim",
        ] {
            assert!(capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|value| value == permission));
        }
    }
    for document in [
        include_str!("../../capabilities/game-telemetry.json"),
        include_str!("../../capabilities/bot-runtime.json"),
    ] {
        let capability: Value = serde_json::from_str(document).unwrap();
        assert!(capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .all(|value| !value.as_str().unwrap().starts_with("allow-mcp-")));
    }
}

fn write_call(id: usize, name: &str, arguments: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":"tools/call","params":{"name":name,"arguments":arguments}})
}

#[tokio::test]
async fn control_requires_local_grant_and_receipts_replay_without_redispatch() {
    let calls = Arc::new(AtomicU64::new(0));
    let observed = calls.clone();
    let readonly = Fixture::new(move |_, _| {
        observed.fetch_add(1, Ordering::SeqCst);
    })
    .await;
    let denied: Value = readonly
        .post(write_call(1, "stop_bot", json!({"requestId":"stop-1"})))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(denied["result"]["isError"], true);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(readonly.core.requests.lock().unwrap().operations.is_empty());
    readonly.core.shutdown();
    let observed = calls.clone();
    let fixture=Fixture::with_control(true,move |query,core| {
        core.claim(&query.id,query.runtime_generation,2).unwrap();
        let authority=core.authorize(&query.id,2,"login_game").unwrap();
        observed.fetch_add(1,Ordering::SeqCst);
        drop(authority);
        core.reply(&query.id,query.runtime_generation,json!({"ok":true,"password":"should-never-retain","nested":{"credentials":{"password":"should-never-retain"}}})).unwrap();
    }).await;
    let body = write_call(
        1,
        "connect",
        json!({"requestId":"connect-1","expectedDraftRevision":0,"username":"offline-probe","password":"private-fixture-password"}),
    );
    let response: Value = fixture
        .post(body.clone())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["result"]["structuredContent"]["ok"], true);
    assert!(!response.to_string().contains("should-never-retain"));
    let replay: Value = fixture
        .post(body.clone())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(response["result"], replay["result"]);
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    let mut changed = body;
    changed["params"]["arguments"]["password"] = json!("different-private-password");
    let conflict: Value = fixture
        .post(changed)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert!(conflict.get("error").is_some());
    let receipt = fixture.core.operation("connect-1").unwrap();
    assert_eq!(receipt["state"], "completed");
    assert!(!receipt.to_string().contains("password"));
    assert_eq!(calls.load(Ordering::SeqCst), 1);
    assert!(fixture.core.requests.lock().unwrap().pending.is_empty());
}

#[tokio::test]
async fn claim_and_effect_entry_recheck_scope_generation_grant_and_single_dispatch() {
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let fixture = Fixture::with_control(true, move |query, _| {
        sent.send(query).unwrap();
    })
    .await;
    let request = fixture
        .post(write_call(
            1,
            "start_bot",
            json!({"requestId":"start-1","expectedDraftRevision":0,"expectedGeneration":2}),
        ))
        .send();
    let process = async {
        let query = received.recv().await.unwrap();
        assert!(fixture
            .core
            .authorize(&query.id, 2, "control_bot:start")
            .is_err());
        assert!(fixture.core.claim(&query.id, 2, 3).is_err());
        fixture.core.claim(&query.id, 2, 2).unwrap();
        assert!(fixture.core.claim(&query.id, 2, 2).is_err());
        assert!(fixture.core.authorize(&query.id, 2, "login_game").is_err());
        assert!(fixture
            .core
            .authorize(&query.id, 3, "control_bot:start")
            .is_err());
        drop(
            fixture
                .core
                .authorize(&query.id, 2, "control_bot:start")
                .unwrap(),
        );
        assert!(fixture
            .core
            .authorize(&query.id, 2, "control_bot:start")
            .is_err());
        assert!(fixture
            .core
            .authorize(&query.id, 2, "control_bot:macro")
            .is_err());
        fixture
            .core
            .reply(&query.id, 2, json!({"ok":true}))
            .unwrap();
    };
    let (_, ()) = tokio::join!(request, process);
    let request = fixture
        .post(write_call(2, "stop_bot", json!({"requestId":"stop-2"})))
        .send();
    let process = async {
        let query = received.recv().await.unwrap();
        fixture.generation.store(3, Ordering::SeqCst);
        fixture.core.claim(&query.id, 2, 3).unwrap();
        drop(
            fixture
                .core
                .authorize(&query.id, 3, "control_bot:stop")
                .unwrap(),
        );
        drop(
            fixture
                .core
                .authorize(&query.id, 4, "control_bot:stop")
                .unwrap(),
        );
        drop(
            fixture
                .core
                .authorize(&query.id, 4, "update_cancel")
                .unwrap(),
        );
        assert!(fixture
            .core
            .authorize(&query.id, 4, "control_bot:start")
            .is_err());
        fixture.core.shutdown();
        assert!(fixture
            .core
            .authorize(&query.id, 4, "control_bot:stop")
            .is_err());
    };
    let (_, ()) = tokio::join!(request, process);
}

#[tokio::test]
async fn expired_unclaimed_write_never_executes_and_claimed_timeout_accepts_late_completion() {
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let fixture = Fixture::with_control(true, move |query, _| {
        sent.send(query).unwrap();
    })
    .await;
    let first = fixture
        .post(write_call(
            1,
            "set_reconnect",
            json!({"requestId":"expires-1","expectedDraftRevision":0,"enabled":true}),
        ))
        .send();
    let process = async {
        let query = received.recv().await.unwrap();
        fixture
            .core
            .requests
            .lock()
            .unwrap()
            .pending
            .get_mut(&query.id)
            .unwrap()
            .expires = Instant::now() - Duration::from_secs(1);
        assert!(fixture.core.claim(&query.id, 2, 2).is_err());
        fixture.core.retire(&query.id);
        assert_eq!(
            fixture.core.operation("expires-1").unwrap()["state"],
            "cancelled"
        );
    };
    let (_, ()) = tokio::join!(first, process);
    let second = fixture
        .post(write_call(
            2,
            "set_reconnect",
            json!({"requestId":"late-2","expectedDraftRevision":0,"enabled":true}),
        ))
        .send();
    let process = async {
        let query = received.recv().await.unwrap();
        fixture.core.claim(&query.id, 2, 2).unwrap();
        tokio::time::sleep(DEADLINE + Duration::from_millis(150)).await;
        assert_eq!(
            fixture.core.operation("late-2").unwrap()["state"],
            "unresolved"
        );
        drop(
            fixture
                .core
                .authorize(&query.id, 2, "save_current_form")
                .unwrap(),
        );
        fixture
            .core
            .reply(&query.id, 2, json!({"ok":true,"revision":1}))
            .unwrap();
        assert_eq!(
            fixture.core.operation("late-2").unwrap()["state"],
            "completed"
        );
        assert!(fixture.core.requests.lock().unwrap().pending.is_empty());
    };
    let (_, ()) = tokio::join!(second, process);
    let replay: Value = fixture
        .post(write_call(
            3,
            "set_reconnect",
            json!({"requestId":"late-2","expectedDraftRevision":0,"enabled":true}),
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(replay["result"]["structuredContent"]["revision"], 1);
}

#[tokio::test]
async fn stop_has_reserved_http_and_pending_capacity_when_four_normal_queries_wait() {
    let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
    let fixture = Fixture::with_control(true, move |query, core| {
        if query.tool == "stop_bot" {
            core.claim(&query.id, query.runtime_generation, 2).unwrap();
            drop(core.authorize(&query.id, 2, "control_bot:stop").unwrap());
            core.reply(&query.id, query.runtime_generation, json!({"stopped":true}))
                .unwrap();
        } else {
            sent.send(query).unwrap();
        }
    })
    .await;
    let requests = (0..MAX_CONCURRENT)
        .map(|id| fixture.post(call(id, "get_status")).send())
        .collect::<Vec<_>>();
    let process = async {
        for _ in 0..MAX_CONCURRENT {
            received.recv().await.unwrap();
        }
        let response = fixture
            .post(write_call(
                99,
                "stop_bot",
                json!({"requestId":"priority-stop"}),
            ))
            .send()
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let response: Value = response.json().await.unwrap();
        assert_eq!(response["result"]["structuredContent"]["stopped"], true);
        assert_eq!(
            fixture.core.requests.lock().unwrap().pending.len(),
            MAX_CONCURRENT
        );
        fixture.core.shutdown();
    };
    let (_, ()) = tokio::join!(futures_util::future::join_all(requests), process);
}

#[tokio::test]
async fn receipt_capacity_fails_closed_without_evicting_replay_keys_or_blocking_reserved_stop() {
    let fixture = Fixture::with_control(true, |query, core| {
        core.claim(&query.id, query.runtime_generation, 2).unwrap();
        core.reply(&query.id, 2, json!({"stopped":true})).unwrap();
    })
    .await;
    {
        let mut requests = fixture.core.requests.lock().unwrap();
        for index in 0..MAX_OPERATIONS {
            requests.operations.insert(
                format!("filled-{index}"),
                Operation {
                    query_id: format!("query-{index}"),
                    tool: "start_bot".into(),
                    action: None,
                    fingerprint: [0; 32],
                    epoch: 0,
                    generation: 2,
                    expected_generation: Some(2),
                    state: "completed",
                    result: Some(json!({"ok":true})),
                    effects: vec![],
                },
            );
        }
        requests.retained_bytes = MAX_LEDGER_BYTES - 262_144;
    }
    let denied: Value = fixture
        .post(write_call(
            1,
            "set_reconnect",
            json!({"requestId":"new-ordinary","expectedDraftRevision":0,"enabled":true}),
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(denied["result"]["isError"], true);
    assert_eq!(
        fixture.core.operation("filled-0").unwrap()["state"],
        "completed"
    );
    let stop: Value = fixture
        .post(write_call(
            2,
            "stop_bot",
            json!({"requestId":"reserved-stop"}),
        ))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(stop["result"]["structuredContent"]["stopped"], true);
    assert_eq!(
        fixture.core.requests.lock().unwrap().operations.len(),
        MAX_OPERATIONS + 1
    );
    assert!(fixture.core.requests.lock().unwrap().retained_bytes <= MAX_LEDGER_BYTES);
    let mut requests = fixture.core.requests.lock().unwrap();
    requests.operations.get_mut("filled-0").unwrap().result =
        Some(json!({"large":"x".repeat(MAX_OUTPUT_BYTES-30)}));
    drop(requests);
    let bounded = fixture.core.operation("filled-0").unwrap();
    assert_eq!(bounded["resultUnavailable"], true);
    assert!(serde_json::to_vec(&bounded).unwrap().len() <= MAX_OUTPUT_BYTES);
}

#[test]
fn tool_arguments_are_strict_and_annotations_distinguish_effects() {
    for name in mcp_logic::TOOL_NAMES {
        let tool = mcp_logic::tool(name).unwrap();
        assert_eq!(
            tool.annotations.unwrap().read_only_hint,
            Some(!mcp_logic::mutating(name))
        );
        assert_eq!(tool.input_schema["additionalProperties"], false);
        assert!(!mcp_logic::arguments_valid(
            name,
            json!({"unexpected":true}).as_object().unwrap()
        ));
    }
    for invalid in [
        json!({"requestId":"bad id"}),
        json!({"requestId":"s","expectedGeneration":2}),
        json!({"requestId":""}),
    ] {
        assert!(!mcp_logic::arguments_valid(
            "stop_bot",
            invalid.as_object().unwrap()
        ));
    }
    assert!(!mcp_logic::arguments_valid("profile",json!({"requestId":"p","expectedDraftRevision":0,"operation":"remove","id":"p","name":"Unexpected"}).as_object().unwrap()));
    assert!(!mcp_logic::arguments_valid(
        "connect",
        json!({"requestId":"p","expectedDraftRevision":0,"password":"secret"})
            .as_object()
            .unwrap()
    ));
    assert!(!mcp_logic::arguments_valid(
        "client_action",
        json!({"requestId":"p","expectedGeneration":2,"action":"rawPacket","request":{}})
            .as_object()
            .unwrap()
    ));
}

#[tokio::test]
async fn external_write_cancellation_retains_replay_protection_and_late_claimed_receipt() {
    use rmcp::{
        model::{CallToolRequest, ClientRequest},
        service::PeerRequestOptions,
    };
    for claimed in [false, true] {
        let (sent, mut received) = tokio::sync::mpsc::unbounded_channel();
        let fixture = Fixture::with_control(true, move |query, core| {
            if claimed {
                core.claim(&query.id, query.runtime_generation, 2).unwrap();
            }
            sent.send(query).unwrap();
        })
        .await;
        let client = ClientConfig::default()
            .serve(fixture.transport())
            .await
            .unwrap();
        let handle=client.send_cancellable_request(ClientRequest::CallToolRequest(CallToolRequest::new(
            CallToolRequestParams::new("set_reconnect").with_arguments(json!({"requestId":"cancel-write","expectedDraftRevision":0,"enabled":true}).as_object().unwrap().clone())
        )),PeerRequestOptions::no_options()).await.unwrap();
        let query = received.recv().await.unwrap();
        handle
            .cancel(Some("offline fixture cancellation".into()))
            .await
            .unwrap();
        let state = if claimed { "unresolved" } else { "cancelled" };
        tokio::time::timeout(Duration::from_secs(1), async {
            while fixture.core.operation("cancel-write").unwrap()["state"] != state {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        assert!(fixture.core.claim(&query.id, 2, 2).is_err());
        if claimed {
            fixture
                .core
                .reply(&query.id, 2, json!({"ok":true}))
                .unwrap();
            assert_eq!(
                fixture.core.operation("cancel-write").unwrap()["state"],
                "completed"
            );
        } else {
            assert!(fixture
                .core
                .authorize(&query.id, 2, "save_current_form")
                .is_err());
            assert!(fixture
                .core
                .reply(&query.id, 2, json!({"ok":true}))
                .is_err());
        }
        client.cancel().await.unwrap();
    }
}

#[tokio::test]
async fn rejected_unclaimed_error_is_retained_and_cannot_later_claim_effects() {
    let fixture = Fixture::with_control(true, |query, core| {
        core.reply(
            &query.id,
            query.runtime_generation,
            json!({"error":"The settings draft changed."}),
        )
        .unwrap();
        assert!(core.claim(&query.id, 2, 2).is_err());
    })
    .await;
    let body = write_call(
        1,
        "set_reconnect",
        json!({"requestId":"stale-draft","expectedDraftRevision":0,"enabled":true}),
    );
    let first: Value = fixture
        .post(body.clone())
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    let replay: Value = fixture
        .post(body)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(first["result"]["isError"], true);
    assert_eq!(first["result"], replay["result"]);
    assert_eq!(
        fixture.core.operation("stale-draft").unwrap()["state"],
        "completed"
    );
}

#[test]
fn operation_fingerprints_are_canonical_for_nested_json_objects() {
    let a:Value=serde_json::from_str(r#"{"requestId":"r","request":{"a":1,"b":{"x":1,"y":2}},"expectedGeneration":2,"action":"command"}"#).unwrap();
    let b:Value=serde_json::from_str(r#"{"action":"command","expectedGeneration":2,"request":{"b":{"y":2,"x":1},"a":1},"requestId":"r"}"#).unwrap();
    assert_eq!(
        mcp_logic::fingerprint("client_action", a.as_object().unwrap()).unwrap(),
        mcp_logic::fingerprint("client_action", b.as_object().unwrap()).unwrap()
    );
}

#[test]
fn replaced_client_state_retires_gameplay_and_readiness_but_keeps_local_draft() {
    let old = json!({"draftRevision":7,"account":{"username":"local-draft"},"gameplay":{"player":{"name":"old character"}},"controls":{"startReady":true}});
    let result = mcp_logic::retired_result("get_client_state", old, 3);
    assert_eq!(result["gameplay"], Value::Null);
    assert_eq!(result["controls"], Value::Null);
    assert_eq!(result["draftRevision"], 7);
    assert_eq!(result["account"]["username"], "local-draft");
    assert_eq!(result["observation"]["runtimeGeneration"], 3);
}

#[test]
fn preview_arguments_match_existing_owner_shapes_and_retire_on_replacement() {
    for (kind, request) in [
        ("workflow", json!({"spec":{}})),
        ("routine", json!({"spec":{}})),
        ("macro", json!({"script":"script \"Preview\""})),
        ("route", json!({"destinationMap":"prontera"})),
        ("service", json!({"definition":{}})),
        ("disposition", json!({})),
        ("supply", json!({})),
    ] {
        assert!(mcp_logic::arguments_valid(
            "preview_bot",
            json!({"kind":kind,"request":request}).as_object().unwrap()
        ));
    }
    assert!(!mcp_logic::arguments_valid(
        "preview_bot",
        json!({"kind":"supply","request":{"start":true}})
            .as_object()
            .unwrap()
    ));
    assert!(!mcp_logic::arguments_valid(
        "preview_bot",
        json!({"kind":"macro","request":{"script":"x".repeat(MAX_OUTPUT_BYTES+1)}})
            .as_object()
            .unwrap()
    ));
    let result =
        mcp_logic::retired_result("preview_bot", json!({"valid":true,"oldRoute":[1,2]}), 4);
    assert!(result.get("error").is_some());
    assert!(result.get("oldRoute").is_none());
}
