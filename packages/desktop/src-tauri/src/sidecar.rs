use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

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
    web_dist_dir: &Path,
    plugins_ui_dir: &Path,
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
        // import.meta.url-relative resolution breaks inside a `bun build
        // --compile` binary - see ZERO_WEB_DIST in packages/daemon/bin/zero.ts.
        .env("ZERO_WEB_DIST", web_dist_dir)
        // Same reason: the daemon's plugins/ dir, holding each plugin's
        // ui/dist/index.js bundle served at GET /plugins/:id/ui.js.
        .env("ZERO_PLUGINS_DIR", plugins_ui_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;

    Ok(SidecarHandle { child })
}

fn default_ready_timeout() -> Duration {
    std::env::var("ZERO_SIDECAR_READY_TIMEOUT_SECS")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .map(Duration::from_secs)
        .unwrap_or(Duration::from_secs(30))
}

impl SidecarHandle {
    /// Blocks reading stdout lines until one parses as the ready JSON, the
    /// process exits first, or the timeout elapses - whichever comes
    /// first. On timeout, kills the child before returning. On failure,
    /// returns the captured stderr tail so the caller can show it in an
    /// error dialog.
    pub fn wait_for_ready(&mut self) -> Result<ReadyInfo, String> {
        self.wait_for_ready_with_timeout(default_ready_timeout())
    }

    fn wait_for_ready_with_timeout(&mut self, timeout: Duration) -> Result<ReadyInfo, String> {
        let stdout = self.child.stdout.take().expect("stdout was piped");
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let reader = BufReader::new(stdout);
            for line in reader.lines() {
                let line = match line {
                    Ok(l) => l,
                    Err(_) => break,
                };
                if let Some(info) = parse_ready_line(&line) {
                    let _ = tx.send(Some(info));
                    return;
                }
            }
            let _ = tx.send(None);
        });

        match rx.recv_timeout(timeout) {
            Ok(Some(info)) => Ok(info),
            Ok(None) => Err(self.stderr_tail_or("sidecar exited before printing a ready line")),
            Err(mpsc::RecvTimeoutError::Timeout) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                self.kill();
                Err(self.stderr_tail_or("sidecar did not become ready within the timeout"))
            }
        }
    }

    fn stderr_tail_or(&mut self, fallback: &str) -> String {
        let mut stderr_tail = String::new();
        if let Some(mut stderr) = self.child.stderr.take() {
            use std::io::Read;
            let _ = stderr.read_to_string(&mut stderr_tail);
        }
        if stderr_tail.is_empty() {
            fallback.to_string()
        } else {
            stderr_tail
        }
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

    #[test]
    fn wait_for_ready_times_out_when_sidecar_never_prints() {
        use std::process::{Command, Stdio};
        let child = Command::new("sleep")
            .arg("5")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("failed to spawn sleep");
        let mut handle = SidecarHandle { child };

        let result = handle.wait_for_ready_with_timeout(std::time::Duration::from_millis(200));

        match result {
            Ok(_) => panic!("expected a timeout error"),
            Err(e) => assert!(e.contains("did not become ready")),
        }
    }
}
