//! iPadOS in-app browser for the saved-list input: a native `WKWebView`
//! overlaid on the main webview at the rectangle the frontend reports, with the
//! app's harvest script run inside it on demand.
//!
//! It exists because Tauri's child webviews (`Window::add_child`) are
//! desktop-only. The app's core (`src/saved.rs`) holds the one implementation
//! of what the browser is *for* — including the script — and calls whichever
//! side can do the work; this is the iPad's side of that.
//!
//! Reading the page and reading its cookies are one call rather than two: an
//! `HttpOnly` session cookie is invisible to the page's own JavaScript, so it
//! has to come from the webview's cookie store, and doing both at once means
//! they can't describe two different pages.
//!
//! On desktop this plugin is an inert shell — every method returns `Err`, so a
//! caller that reaches it by mistake says so rather than doing nothing.

use serde::{Deserialize, Serialize};
use tauri::{
    plugin::{Builder, PluginHandle, TauriPlugin},
    Manager, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_saved_browser);

pub struct SavedBrowser<R: Runtime>(Option<PluginHandle<R>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenArgs {
    pub url: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Serialize)]
pub struct BoundsArgs {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// What the page and its cookie store said, together.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureAnswer {
    /// Whatever the harvest script returned, as it returned it.
    pub json: String,
    /// A ready-made `Cookie:` header for the page's own host, or empty.
    #[serde(default)]
    pub cookie: String,
}

#[derive(Deserialize)]
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
struct EmptyResponse {}

impl<R: Runtime> SavedBrowser<R> {
    #[cfg(target_os = "ios")]
    fn handle(&self) -> Result<&PluginHandle<R>, String> {
        self.0
            .as_ref()
            .ok_or_else(|| "the browser plugin didn't start".to_string())
    }

    fn call(&self, method: &str, args: impl Serialize) -> Result<(), String> {
        #[cfg(target_os = "ios")]
        {
            self.handle()?
                .run_mobile_plugin::<EmptyResponse>(method, args)
                .map(|_| ())
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = (method, args);
            Err("the in-app browser plugin is iPadOS-only".into())
        }
    }

    pub fn open(&self, args: OpenArgs) -> Result<(), String> {
        self.call("openBrowser", args)
    }

    pub fn set_bounds(&self, args: BoundsArgs) -> Result<(), String> {
        self.call("setBounds", args)
    }

    pub fn back(&self) -> Result<(), String> {
        self.call("goBack", serde_json::json!({}))
    }

    pub fn close(&self) -> Result<(), String> {
        self.call("closeBrowser", serde_json::json!({}))
    }

    /// Runs `script` in the browser and hands back what it said, with the
    /// cookies the page was read under.
    pub fn capture(&self, script: &str) -> Result<CaptureAnswer, String> {
        #[cfg(target_os = "ios")]
        {
            self.handle()?
                .run_mobile_plugin::<CaptureAnswer>(
                    "capturePage",
                    serde_json::json!({ "script": script }),
                )
                .map_err(|e| e.to_string())
        }
        #[cfg(not(target_os = "ios"))]
        {
            let _ = script;
            Err("the in-app browser plugin is iPadOS-only".into())
        }
    }
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("saved-browser")
        .setup(|app, _api| {
            #[cfg(target_os = "ios")]
            {
                let handle = _api.register_ios_plugin(init_plugin_saved_browser)?;
                app.manage(SavedBrowser::<R>(Some(handle)));
            }
            #[cfg(not(target_os = "ios"))]
            {
                app.manage(SavedBrowser::<R>(None));
            }
            Ok(())
        })
        .build()
}
