//! Printing a generated digest through the system's own print flow.
//!
//! The document is written to a temporary file and handed to the platform's
//! printing path, which on the desktop means the standard print dialog rather
//! than a job fired straight at the default printer: this app exists to make
//! booklets, and the paper size and double-sided settings are exactly what the
//! dialog is for.

use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::path::{Path, PathBuf};

use crate::log;

/// Writes the document out and asks the system to print it. Returns a line
/// describing what happened, which differs enough by platform to be worth
/// saying out loud in the log.
#[tauri::command]
pub async fn print_file(
    app: tauri::AppHandle,
    file_name: String,
    bytes_b64: String,
) -> Result<String, String> {
    let bytes = STANDARD
        .decode(bytes_b64)
        .map_err(|e| format!("bad document payload: {e}"))?;
    let path = temp_path(&file_name);
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;
    log::info(&app, "print", format!("Printing {}", path.display()));
    // The print dialog stays open for as long as the reader takes over it, so
    // it waits on a blocking thread rather than one of the runtime's workers.
    tokio::task::spawn_blocking(move || print_path(&path))
        .await
        .map_err(|e| format!("the print job didn't run: {e}"))?
}

/// A file name reduced to a bare name in the temp directory — whatever the UI
/// sends, nothing here gets to name a path.
fn temp_path(file_name: &str) -> PathBuf {
    let name = Path::new(file_name)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .filter(|n| !n.is_empty() && n != "." && n != "..")
        .unwrap_or_else(|| "sub-digest.pdf".to_string());
    std::env::temp_dir().join(name)
}

/// Preview's own `print` command raises the standard macOS print panel with the
/// document loaded. Automation can be refused, so a failure falls back to
/// opening the file — ⌘P is then one keystroke away.
#[cfg(target_os = "macos")]
fn print_path(path: &Path) -> Result<String, String> {
    use std::process::Command;

    let quoted = path
        .to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"");
    let script = format!(
        "tell application \"Preview\"\nactivate\nprint POSIX file \"{quoted}\" with print dialog\nend tell"
    );
    let output = Command::new("osascript")
        .arg("-e")
        .arg(&script)
        .output()
        .map_err(|e| format!("could not run osascript: {e}"))?;
    if output.status.success() {
        return Ok(format!("Opened the print dialog for {}", path.display()));
    }

    let why = String::from_utf8_lossy(&output.stderr).trim().to_string();
    Command::new("open")
        .args(["-a", "Preview"])
        .arg(path)
        .status()
        .map_err(|e| format!("could not print, and could not open the file either: {e}"))?;
    Ok(format!(
        "Preview wouldn't take the print command ({why}); opened {} instead — press Cmd-P",
        path.display()
    ))
}

#[cfg(target_os = "windows")]
fn print_path(path: &Path) -> Result<String, String> {
    use std::process::Command;

    let quoted = path.to_string_lossy().replace('\'', "''");
    let status = Command::new("powershell")
        .args([
            "-NoProfile",
            "-Command",
            &format!("Start-Process -FilePath '{quoted}' -Verb Print"),
        ])
        .status()
        .map_err(|e| format!("could not start the print job: {e}"))?;
    if status.success() {
        Ok(format!("Sent {} to the printer", path.display()))
    } else {
        Err(format!("printing {} failed", path.display()))
    }
}

/// No desktop-wide print panel to raise from a command line here, so the file
/// goes to whatever opens PDFs and the reader prints from there.
#[cfg(all(
    unix,
    not(target_os = "macos"),
    not(target_os = "ios"),
    not(target_os = "android")
))]
fn print_path(path: &Path) -> Result<String, String> {
    use std::process::Command;

    Command::new("xdg-open")
        .arg(path)
        .status()
        .map_err(|e| format!("could not open {} to print it: {e}", path.display()))?;
    Ok(format!(
        "Opened {} in the default PDF viewer — print from there",
        path.display()
    ))
}

#[cfg(any(target_os = "ios", target_os = "android"))]
fn print_path(path: &Path) -> Result<String, String> {
    Err(format!(
        "Printing isn't available on this device — use Save PDF… and print {} from Files.",
        path.display()
    ))
}
