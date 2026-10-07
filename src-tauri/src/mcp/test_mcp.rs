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
async fn official_external_client_discovers_and_calls_all_four_tools() {
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
    assert_eq!(tools.len(), 4);
    assert!(tools
        .iter()
        .all(|tool| tool.annotations.as_ref().unwrap().read_only_hint == Some(true)));
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
    assert!(fixture.core.pending.lock().unwrap().is_empty());
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
    assert!(fixture.core.pending.lock().unwrap().is_empty());
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
    assert!(fixture.core.pending.lock().unwrap().is_empty());
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
        assert_eq!(fixture.core.pending.lock().unwrap().len(), MAX_CONCURRENT);
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
        assert!(fixture.core.pending.lock().unwrap().is_empty());
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
    assert!(fixture.core.pending.lock().unwrap().is_empty());
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
        while !fixture.core.pending.lock().unwrap().is_empty() {
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
    assert!(fixture.core.pending.lock().unwrap().is_empty());
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
        for permission in ["allow-mcp-set-enabled", "allow-mcp-reply"] {
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
