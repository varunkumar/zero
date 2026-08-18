use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};

#[derive(Deserialize)]
struct ReadyLine {
    port: u16,
    token: String,
}

pub struct ReadyInfo {
    pub port: u16,
    pub token: String,
}

pub struct SidecarHandle {
    child: Child,
}

/// Parses the daemon's `--json` ready line (see
/// packages/daemon/bin/zero.ts). Returns None for any line that isn't
/// valid JSON matching the expected shape - callers keep reading
/// subsequent lines until one parses or the stream ends.
fn parse_ready_line(line: &str) -> Option<ReadyInfo> {
    let parsed: ReadyLine = serde_json::from_str(line).ok()?;
    Some(ReadyInfo { port: parsed.port, token: parsed.token })
}

pub fn spawn(
    sidecar_bin: &Path,
    node_runtime_dir: &Path,
    workspace: &Path,
) -> std::io::Result<SidecarHandle> {
    let child = Command::new(sidecar_bin)
        .arg("serve")
        .arg(workspace)
        .arg("--port")
        .arg("0")
        .arg("--json")
        .env("ZERO_PTY_NODE_BIN", node_runtime_dir.join("node"))
        .env("ZERO_PTY_WORKER_DIR", node_runtime_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    Ok(SidecarHandle { child })
}

impl SidecarHandle {
    /// Blocks reading stdout lines until one parses as the ready JSON,
    /// or the process exits first. On failure, returns the captured
    /// stderr tail so the caller can show it in an error dialog.
    pub fn wait_for_ready(&mut self) -> Result<ReadyInfo, String> {
        let stdout = self.child.stdout.take().expect("stdout was piped");
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if let Some(info) = parse_ready_line(&line) {
                return Ok(info);
            }
        }
        let mut stderr_tail = String::new();
        if let Some(mut stderr) = self.child.stderr.take() {
            use std::io::Read;
            let _ = stderr.read_to_string(&mut stderr_tail);
        }
        Err(if stderr_tail.is_empty() {
            "sidecar exited before printing a ready line".to_string()
        } else {
            stderr_tail
        })
    }

    pub fn kill(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_well_formed_ready_line() {
        let info = parse_ready_line(r#"{"port":54321,"token":"abc123","gatewayInfo":null}"#);
        assert!(info.is_some());
        let info = info.unwrap();
        assert_eq!(info.port, 54321);
        assert_eq!(info.token, "abc123");
    }

    #[test]
    fn rejects_non_json_lines() {
        assert!(parse_ready_line("zero ready: http://127.0.0.1:1234").is_none());
    }

    #[test]
    fn rejects_json_missing_required_fields() {
        assert!(parse_ready_line(r#"{"port":1234}"#).is_none());
    }
}
