// The opening screen in a REAL WKWebView, started the way the desktop shell starts it.
//
//   built and run by scripts/verify/splash-webkit.sh; by hand:
//   SplashProbe.app/Contents/MacOS/probe <page-dir> [page.html]
//
// Serves <page-dir> over a `tauri` custom scheme exactly like Tauri's asset handler (a full
// 200 body, Content-Type by extension, no Range), with wry's autoplay config
// (mediaTypesRequiringUserActionForPlayback = []), in a transparent borderless window built
// before the run loop starts, like Tauri's setup. A fake `__TAURI_INTERNALS__.invoke` posts
// to a WKScriptMessageHandler; `splash_play` is answered with
// evaluateJavaScript("window.__dcSplashPlay && window.__dcSplashPlay()"), which is what
// src/splash.rs does through wry's `eval`.
//
// Why it has to be real WebKit: in macOS Low Power Mode WebKit refuses every <video> play()
// no user gesture started, muted or not, and a script run through evaluateJavaScript counts
// as one. No other engine has that rule. Outside Low Power Mode the restriction is off and
// any page passes, so the --old FAIL only proves something with Low Power Mode on.
//
// Logs every play() call and its outcome, media events, currentTime and the card's class,
// then exits 0 (PASS) or 1 (FAIL). PASS = a play() resolved with muted=false, `ended` fired,
// the card never went `still`, and `splash_done` came only after `ended` (no timer cut the clip).
import Cocoa
import WebKit

let root = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let page = CommandLine.arguments.count > 2 ? CommandLine.arguments[2] : "splash.html"
let t0 = Date()
func ms() -> Int { Int(Date().timeIntervalSince(t0) * 1000) }
func say(_ s: String) { print(String(format: "%5d  ", ms()) + s); fflush(stdout) }

var unmutedPlay = false
var ended = false
var everStill = false
var done = false
var doneBeforeEnded = false
var endedMs = -1
var doneMs = -1
var maxT = 0.0
var ranges = 0

class Scheme: NSObject, WKURLSchemeHandler {
  func webView(_ w: WKWebView, start task: WKURLSchemeTask) {
    let path = task.request.url!.path
    let file = root + (path == "/" ? "/index.html" : path)
    if task.request.value(forHTTPHeaderField: "Range") != nil { ranges += 1 }
    guard let data = FileManager.default.contents(atPath: file) else {
      task.didReceive(HTTPURLResponse(url: task.request.url!, statusCode: 404, httpVersion: "HTTP/1.1", headerFields: [:])!)
      task.didFinish()
      return
    }
    let ext = (file as NSString).pathExtension
    let mime = ["html": "text/html", "mp4": "video/mp4", "jpg": "image/jpeg", "png": "image/png"][ext] ?? "application/octet-stream"
    let resp = HTTPURLResponse(url: task.request.url!, statusCode: 200, httpVersion: "HTTP/1.1",
      headerFields: ["Content-Type": mime, "Content-Length": "\(data.count)"])!
    task.didReceive(resp); task.didReceive(data); task.didFinish()
  }
  func webView(_ w: WKWebView, stop task: WKURLSchemeTask) {}
}

var wvRef: WKWebView? = nil
class Msg: NSObject, WKScriptMessageHandler {
  func userContentController(_ u: WKUserContentController, didReceive m: WKScriptMessage) {
    let s = "\(m.body)"
    say(s)
    if s == "invoke splash_play" {
      // src/splash.rs `splash_play`: the shell's eval, the one thing that counts as a gesture.
      wvRef?.evaluateJavaScript("window.__dcSplashPlay && window.__dcSplashPlay()", completionHandler: nil)
    }
    if s == "invoke splash_done" && !done { done = true; doneMs = ms(); doneBeforeEnded = !ended }
    if s.hasPrefix("play() resolved muted=false") { unmutedPlay = true }
    if s.hasPrefix("media ended") && !ended { ended = true; endedMs = ms() }
    if s.hasPrefix("card class=") && s.split(separator: " ").contains("still") { everStill = true }
    if let r = s.range(of: " t=") {
      let num = s[r.upperBound...].prefix { $0.isNumber || $0 == "." }
      if let t = Double(num) { maxT = max(maxT, t) }
    }
  }
}

let hook = """
(function(){
  var post = function(s){ window.webkit.messageHandlers.probe.postMessage(String(s)); };
  window.__TAURI_INTERNALS__ = { invoke: function(c){ post('invoke ' + c); return Promise.resolve(); } };
  var P = HTMLMediaElement.prototype, op = P.play;
  P.play = function(){
    var el = this;
    post('play() called muted=' + el.muted + ' vol=' + el.volume);
    var r = op.apply(el, arguments);
    r.then(function(){ post('play() resolved muted=' + el.muted + ' vol=' + el.volume); },
      function(e){ post('play() REJECTED ' + e.name + ': ' + e.message); });
    return r;
  };
  ['canplay','playing','pause','ended','error'].forEach(function(ev){
    document.addEventListener(ev, function(e){ var v = e.target; post('media ' + ev + ' t=' + v.currentTime.toFixed(2) + (v.error ? ' err=' + v.error.code : '')); }, true);
  });
  var lastT = -1;
  setInterval(function(){ var v = document.querySelector('video'); var c = document.getElementById('card');
    if (v && v.currentTime !== lastT) { lastT = v.currentTime; post('tick t=' + v.currentTime.toFixed(2) + ' paused=' + v.paused + ' muted=' + v.muted + ' card=' + (c && c.className)); } }, 200);
  new MutationObserver(function(){ var c = document.getElementById('card'); if (c) post('card class=' + c.className); })
    .observe(document.documentElement, { subtree: true, attributes: true, attributeFilter: ['class'] });
})();
"""

let app = NSApplication.shared
app.setActivationPolicy(.regular)
let cfg = WKWebViewConfiguration()
cfg.setURLSchemeHandler(Scheme(), forURLScheme: "tauri")
cfg.mediaTypesRequiringUserActionForPlayback = []
let ucc = WKUserContentController()
ucc.add(Msg(), name: "probe")
ucc.addUserScript(WKUserScript(source: hook, injectionTime: .atDocumentStart, forMainFrameOnly: true))
cfg.userContentController = ucc
let win = NSWindow(contentRect: NSRect(x: 300, y: 300, width: 720, height: 405), styleMask: [.borderless], backing: .buffered, defer: false)
win.isOpaque = false; win.backgroundColor = .clear; win.hasShadow = true; win.level = .floating
let wv = WKWebView(frame: win.contentView!.bounds, configuration: cfg)
wv.setValue(false, forKey: "drawsBackground")
win.contentView!.addSubview(wv); wvRef = wv
win.center()
win.makeKeyAndOrderFront(nil)
say("load tauri://localhost/\(page) from \(root)")
wv.load(URLRequest(url: URL(string: "tauri://localhost/" + page)!))

func finish() {
  let checks: [(String, Bool)] = [
    ("play() resolved with muted=false", unmutedPlay),
    ("ended fired (max t=\(String(format: "%.2f", maxT)))", ended),
    ("card never in still mode", !everStill),
    // A timer must not cut a playing clip; in still mode there is no clip to cut.
    everStill
      ? ("splash_done after ended: n/a (still mode)", true)
      : ("splash_done reported only after ended (ended@\(endedMs)ms, done@\(doneMs)ms)", ended && done && !doneBeforeEnded),
  ]
  print("")
  for (name, ok) in checks { print("  \(ok ? "ok  " : "FAIL")  \(name)") }
  print("  splash_done reported: \(done)   Range requests (served full 200): \(ranges)")
  let pass = checks.allSatisfy { $0.1 }
  print("\n\(pass ? "PASS" : "FAIL")  splash-webkit \(page)")
  fflush(stdout)
  exit(pass ? 0 : 1)
}
// Stop once the page reported (after its clip ended, or after it fell back to the still), or
// at the shell's own splash deadline.
Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { _ in
  if (ended && done) || (everStill && done) || ms() > 8000 { finish() }
}
app.activate(ignoringOtherApps: true)
app.run()
