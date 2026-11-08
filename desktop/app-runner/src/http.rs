//! A tiny loopback HTTP/1.0 client. Dependency-free on purpose: the runner only ever
//! talks to 127.0.0.1 (the dashboard server and the app's gateway), always with a bounded
//! connect and read time. HTTP/1.0 makes Node answer without chunked encoding.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub body: Vec<u8>,
}

pub struct Request<'a> {
    pub port: u16,
    pub method: &'a str,
    pub path: &'a str,
    pub bearer: Option<&'a str>,
    pub content_type: Option<&'a str>,
    pub body: &'a [u8],
    pub timeout: Duration,
}

pub fn send(req: &Request) -> io::Result<Response> {
    let addr: SocketAddr = ([127, 0, 0, 1], req.port).into();
    let connect = req.timeout.min(Duration::from_secs(2));
    let mut stream = TcpStream::connect_timeout(&addr, connect)?;
    stream.set_read_timeout(Some(req.timeout))?;
    stream.set_write_timeout(Some(req.timeout))?;
    stream.write_all(&encode(req))?;
    let mut raw = Vec::new();
    // Bounded: a heartbeat or launch answer is small; a runaway peer cannot fill memory.
    stream.take(4 * 1024 * 1024).read_to_end(&mut raw)?;
    parse(&raw).ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "not an HTTP response"))
}

/// The request bytes. No Origin header: Bearer requests must carry none (gateway rule).
pub fn encode(req: &Request) -> Vec<u8> {
    let mut head = format!(
        "{} {} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\nUser-Agent: dreamcontext-app-runner\r\nContent-Length: {}\r\n",
        req.method,
        req.path,
        req.port,
        req.body.len()
    );
    if let Some(t) = req.bearer {
        head.push_str(&format!("Authorization: Bearer {t}\r\n"));
    }
    if let Some(ct) = req.content_type {
        head.push_str(&format!("Content-Type: {ct}\r\n"));
    }
    head.push_str("\r\n");
    let mut out = head.into_bytes();
    out.extend_from_slice(req.body);
    out
}

pub fn parse(raw: &[u8]) -> Option<Response> {
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n")?;
    let head = std::str::from_utf8(&raw[..split]).ok()?;
    let status_line = head.lines().next()?;
    let mut parts = status_line.split_whitespace();
    let proto = parts.next()?;
    if !proto.starts_with("HTTP/1.") {
        return None;
    }
    let status: u16 = parts.next()?.parse().ok()?;
    let mut body = raw[split + 4..].to_vec();
    // Honour Content-Length when present (a keep-alive peer would leave junk after it).
    for line in head.lines().skip(1) {
        if let Some((k, v)) = line.split_once(':') {
            if k.trim().eq_ignore_ascii_case("content-length") {
                if let Ok(n) = v.trim().parse::<usize>() {
                    body.truncate(n);
                }
            }
        }
    }
    Some(Response { status, body })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encodes_bearer_without_origin() {
        let r = Request {
            port: 4173,
            method: "POST",
            path: "/__dc/runner/heartbeat",
            bearer: Some("tok"),
            content_type: Some("application/json"),
            body: b"{}",
            timeout: Duration::from_secs(1),
        };
        let s = String::from_utf8(encode(&r)).unwrap();
        assert!(s.starts_with("POST /__dc/runner/heartbeat HTTP/1.0\r\nHost: 127.0.0.1:4173\r\n"));
        assert!(s.contains("Authorization: Bearer tok\r\n"));
        assert!(s.contains("Content-Length: 2\r\n"));
        assert!(!s.to_ascii_lowercase().contains("origin:"));
        assert!(s.ends_with("\r\n\r\n{}"));
    }

    #[test]
    fn parses_status_and_body() {
        let r = parse(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}junk").unwrap();
        assert_eq!(r.status, 200);
        assert_eq!(r.body, b"{}");
        let r = parse(b"HTTP/1.1 401 Unauthorized\r\n\r\nno").unwrap();
        assert_eq!(r.status, 401);
        assert!(parse(b"garbage").is_none());
        assert!(parse(b"SSH-2.0\r\n\r\n").is_none());
    }
}
