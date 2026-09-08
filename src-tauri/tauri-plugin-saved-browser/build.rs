// No JS-invokable commands: the app's Rust core drives every call through
// run_mobile_plugin, and the page's answer comes back as that call's result
// rather than as an event. Nothing here is reachable from the frontend.
const COMMANDS: &[&str] = &[];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).ios_path("ios").build();
}
