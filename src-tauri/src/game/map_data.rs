//! Fixed public catalogue downloads for the local Bot-only webview.
use serde::Serialize;
use std::time::Duration;
use tauri::Webview;

const MAPS_URL: &str =
    "https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/maps.json";
const MONSTERS_URL: &str =
    "https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/monsterdatabase.json";
const MAX_DOCUMENT_BYTES: usize = 2_000_000;
const DEADLINE: Duration = Duration::from_secs(12);
const UNAVAILABLE: &str = "Map database unavailable.";

#[derive(Debug, Serialize)]
pub(crate) struct MapAssets {
    maps: String,
    monsters: String,
}

async fn public_document(client: &reqwest::Client, url: &str) -> Result<String, String> {
    let mut response = client.get(url).send().await.map_err(|_| UNAVAILABLE)?;
    if !response.status().is_success() {
        return Err(UNAVAILABLE.into());
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_DOCUMENT_BYTES as u64)
    {
        return Err("Map database exceeds its limit.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| UNAVAILABLE)? {
        if chunk.len() > MAX_DOCUMENT_BYTES - bytes.len() {
            return Err("Map database exceeds its limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    String::from_utf8(bytes).map_err(|_| "Invalid map database text.".into())
}

async fn fetch_assets(
    client: &reqwest::Client,
    maps_url: &str,
    monsters_url: &str,
    deadline: Duration,
) -> Result<MapAssets, String> {
    // Dropping the joined future retires both reads after any failure or deadline.
    tokio::time::timeout(deadline, async {
        let (maps, monsters) = tokio::try_join!(
            public_document(client, maps_url),
            public_document(client, monsters_url)
        )?;
        Ok(MapAssets { maps, monsters })
    })
    .await
    .map_err(|_| UNAVAILABLE.to_string())?
}

#[tauri::command]
pub(crate) async fn map_database(window: Webview) -> Result<MapAssets, String> {
    crate::require_view(&window, "game")?;
    if crate::session::direct::runtime_mode(&window)?
        != crate::session::login::ConnectionMode::BotOnly
    {
        return Err("Command requires the bundled bot runtime.".into());
    }
    // No caller-supplied URLs, credentials, cookies, redirects or filesystem data.
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .timeout(DEADLINE)
        .user_agent("Rayrag-Companion")
        .build()
        .map_err(|_| UNAVAILABLE)?;
    fetch_assets(&client, MAPS_URL, MONSTERS_URL, DEADLINE).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    fn request_headers(reader: &mut impl Read) -> std::io::Result<Vec<u8>> {
        let mut request = Vec::new();
        let mut chunk = [0; 512];
        loop {
            let available = chunk.len().min(4096 - request.len());
            if available == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "Request headers exceed their limit.",
                ));
            }
            let count = reader.read(&mut chunk[..available])?;
            if count == 0 {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::UnexpectedEof,
                    "Incomplete request headers.",
                ));
            }
            request.extend_from_slice(&chunk[..count]);
            if let Some(end) = request.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                request.truncate(end + 4);
                return Ok(request);
            }
        }
    }
    #[test]
    fn request_reader_captures_fragmented_headers_and_rejects_incomplete_or_oversized_headers() {
        struct Fragmented<'a>(&'a [u8]);
        impl Read for Fragmented<'_> {
            fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
                let size = buffer.len().min(7);
                self.0.read(&mut buffer[..size])
            }
        }
        let headers = b"GET /asset HTTP/1.1\r\nHost: localhost\r\nAuthorization: test\r\nCookie: test\r\n\r\n";
        assert_eq!(request_headers(&mut Fragmented(headers)).unwrap(), headers);
        assert!(request_headers(&mut &headers[..headers.len() - 1]).is_err());
        assert!(request_headers(&mut &vec![b'a'; 4097][..]).is_err());
    }
    #[test]
    fn catalogue_capability_is_exclusive_to_the_local_bot_runtime() {
        let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("capabilities");
        let mut admitted = Vec::new();
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().is_none_or(|extension| extension != "json") {
                continue;
            }
            let capability: serde_json::Value =
                serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
            if capability["permissions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|permission| permission == "allow-map-database")
            {
                assert_eq!(capability["local"], true);
                assert_eq!(capability["webviews"], serde_json::json!(["game"]));
                assert!(capability.get("remote").is_none());
                admitted.push(capability["identifier"].as_str().unwrap().to_string());
            }
        }
        assert_eq!(admitted, vec!["bot-runtime"]);
    }
    fn server(response: Vec<u8>) -> (String, std::thread::JoinHandle<Vec<u8>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/asset", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let request = request_headers(&mut stream).unwrap();
            let _ = stream.write_all(&response);
            request
        });
        (url, handle)
    }
    fn response(body: &[u8]) -> Vec<u8> {
        let mut response = format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        response.extend_from_slice(body);
        response
    }
    fn client() -> reqwest::Client {
        let _ = rustls::crypto::ring::default_provider().install_default();
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap()
    }
    #[tokio::test]
    async fn downloads_both_public_texts_without_account_headers() {
        let (maps_url, maps_server) = server(response(br#"{"Items":[]}"#));
        let (monsters_url, monsters_server) = server(response(br#"{"Items":[]}"#));
        let assets = fetch_assets(&client(), &maps_url, &monsters_url, DEADLINE)
            .await
            .unwrap();
        assert_eq!(assets.maps, "{\"Items\":[]}");
        assert_eq!(assets.monsters, assets.maps);
        for request in [maps_server.join().unwrap(), monsters_server.join().unwrap()] {
            let request = String::from_utf8(request).unwrap().to_ascii_lowercase();
            assert!(request.starts_with("get /asset http/1.1\r\n"));
            assert!(!request.contains("authorization:"));
            assert!(!request.contains("cookie:"));
        }
    }
    #[tokio::test]
    async fn rejects_redirect_status_invalid_utf8_and_declared_or_streamed_oversize() {
        let chunk = vec![b'a'; MAX_DOCUMENT_BYTES + 1];
        let mut streamed = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n",
            chunk.len()
        )
        .into_bytes();
        streamed.extend_from_slice(&chunk);
        streamed.extend_from_slice(b"\r\n0\r\n\r\n");
        for data in [
            b"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/secret\r\nContent-Length: 0\r\n\r\n".to_vec(),
            b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n".to_vec(), response(&[0xff]),
            format!("HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n", MAX_DOCUMENT_BYTES + 1).into_bytes(), streamed,
        ] {
            let (url, handle) = server(data); assert!(public_document(&client(), &url).await.is_err()); handle.join().unwrap();
        }
    }
    #[tokio::test]
    async fn one_deadline_bounds_an_incomplete_document() {
        let (maps_url, maps_server) = server(response(br#"{"Items":[]}"#));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let monsters_url = format!("http://{}/asset", listener.local_addr().unwrap());
        let (finished, stop) = std::sync::mpsc::channel();
        let pending = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let request = request_headers(&mut stream).unwrap();
            assert!(request.starts_with(b"GET /asset HTTP/1.1\r\n"));
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 50\r\n\r\n{")
                .unwrap();
            // Keep the body incomplete until the caller's deadline returns.
            stop.recv_timeout(Duration::from_secs(2)).unwrap();
        });
        assert!(fetch_assets(
            &client(),
            &maps_url,
            &monsters_url,
            Duration::from_millis(50)
        )
        .await
        .is_err());
        finished.send(()).unwrap();
        maps_server.join().unwrap();
        pending.join().unwrap();
    }
}
