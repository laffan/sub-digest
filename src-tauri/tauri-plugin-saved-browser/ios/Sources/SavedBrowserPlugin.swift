import SwiftRs
import Tauri
import UIKit
import WebKit

// Saved-browser plugin — the iPad half of the saved-list input.
//
// The React BrowserModal renders the chrome (header, Back / Use this page /
// Close) and tells us the rectangle its body occupies; we overlay a native
// WKWebView there. The user signs in to the site the way they always sign in —
// password manager, two-factor, single sign-on, whatever the site asks for —
// navigates to the list they want, and presses Use this page.
//
// The app's Rust core owns what "use this page" means: it hands us the harvest
// script and we run it, so there is one copy of that logic rather than one per
// platform. What comes back is that script's answer together with a Cookie
// header for the page's own host — one call, because an HttpOnly session cookie
// is invisible to the page's own JavaScript and has to come from the webview's
// cookie store, and because two calls could describe two different pages.
//
// Methods (all driven from Rust via run_mobile_plugin, never from JS):
//   openBrowser  { url, x, y, w, h }
//   setBounds    { x, y, w, h }
//   goBack       {}
//   capturePage  { script }  → { json, cookie }
//   closeBrowser {}

class SavedBrowserPlugin: Plugin, WKNavigationDelegate, WKUIDelegate {
  private var hostWebView: WKWebView?
  private var browserView: WKWebView?

  @objc public override func load(webview: WKWebView) {
    self.hostWebView = webview
  }

  struct OpenArgs: Decodable {
    let url: String
    let x: Double
    let y: Double
    let w: Double
    let h: Double
  }

  struct BoundsArgs: Decodable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
  }

  struct CaptureArgs: Decodable {
    let script: String
  }

  private func frameFor(x: Double, y: Double, w: Double, h: Double) -> CGRect {
    // CSS pixels in the host webview == UIKit points, offset by wherever the
    // host sits in its superview (normally 0,0 / full-window).
    let origin = hostWebView?.frame.origin ?? .zero
    return CGRect(x: origin.x + x, y: origin.y + y, width: max(w, 50), height: max(h, 50))
  }

  @objc public func openBrowser(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenArgs.self)
    guard let target = URL(string: args.url) else {
      invoke.reject("That isn't an address the browser can open: \(args.url)")
      return
    }
    DispatchQueue.main.async {
      self.teardown()
      guard let host = self.hostWebView, let parent = host.superview else {
        return
      }
      let config = WKWebViewConfiguration()
      // The default store, so a signed-in session survives closing the modal
      // and reopening it — signing in once is the point.
      config.websiteDataStore = .default()
      let wv = WKWebView(
        frame: self.frameFor(x: args.x, y: args.y, w: args.w, h: args.h),
        configuration: config
      )
      wv.navigationDelegate = self
      wv.uiDelegate = self
      wv.allowsBackForwardNavigationGestures = true
      parent.addSubview(wv)
      self.browserView = wv
      wv.load(URLRequest(url: target))
    }
    invoke.resolve()
  }

  @objc public func setBounds(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(BoundsArgs.self)
    DispatchQueue.main.async {
      self.browserView?.frame = self.frameFor(x: args.x, y: args.y, w: args.w, h: args.h)
    }
    invoke.resolve()
  }

  @objc public func goBack(_ invoke: Invoke) throws {
    DispatchQueue.main.async { self.browserView?.goBack() }
    invoke.resolve()
  }

  @objc public func closeBrowser(_ invoke: Invoke) throws {
    DispatchQueue.main.async { self.teardown() }
    invoke.resolve()
  }

  /// Run the app's harvest script in the browser and hand back what it said,
  /// with a Cookie header for the host it said it about.
  @objc public func capturePage(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(CaptureArgs.self)
    DispatchQueue.main.async {
      guard let wv = self.browserView, let url = wv.url else {
        invoke.reject("No page is open to read")
        return
      }
      wv.evaluateJavaScript(args.script) { result, error in
        if let error = error {
          invoke.reject("The page couldn't be read: \(error.localizedDescription)")
          return
        }
        // The script returns a JSON string; anything else means it didn't run
        // as expected, and passing it on would only fail further along.
        guard let json = result as? String else {
          invoke.reject("The page answered with something unreadable")
          return
        }
        wv.configuration.websiteDataStore.httpCookieStore.getAllCookies { cookies in
          let header = Self.cookieHeader(for: url, from: cookies)
          invoke.resolve(["json": json, "cookie": header])
        }
      }
    }
  }

  // MARK: - Helpers

  /// The cookies that belong to this page's host, as a request header. Cookies
  /// for other sites the browser happened to visit are left where they are.
  private static func cookieHeader(for url: URL, from cookies: [HTTPCookie]) -> String {
    guard let host = url.host?.lowercased() else { return "" }
    let mine = cookies.filter { cookie in
      let domain = cookie.domain.hasPrefix(".")
        ? String(cookie.domain.dropFirst()).lowercased()
        : cookie.domain.lowercased()
      return host == domain || host.hasSuffix("." + domain)
    }
    return HTTPCookie.requestHeaderFields(with: mine)["Cookie"] ?? ""
  }

  // Fold popups (window.open / target=_blank) into the same webview, so a
  // site's "open in a new tab" links go somewhere inside the modal.
  public func webView(
    _ webView: WKWebView,
    createWebViewWith configuration: WKWebViewConfiguration,
    for navigationAction: WKNavigationAction,
    windowFeatures: WKWindowFeatures
  ) -> WKWebView? {
    if let url = navigationAction.request.url {
      webView.load(URLRequest(url: url))
    }
    return nil
  }

  private func teardown() {
    browserView?.stopLoading()
    browserView?.removeFromSuperview()
    browserView = nil
  }
}

@_cdecl("init_plugin_saved_browser")
func initPlugin() -> Plugin {
  return SavedBrowserPlugin()
}
