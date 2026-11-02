# What the app window is (and is not)

- A WKWebView on `http://127.0.0.1:<port>`. The port is kept per app, so `localStorage` and
  IndexedDB survive restarts. If that port is taken by something else, the app opens on a
  temporary port once and its browser data LOOKS empty (the card says so). Keep anything that
  matters in the backend (`DC_DATA_DIR`, the brain's `_dream_context/apps/<slug>/`, backed up
  outside every repo and never synced).
- Works: `alert/confirm/prompt`, file inputs, downloads (to ~/Downloads), Cmd-C/Cmd-V with
  Turkish characters, Cmd-R, WebSockets (HMR included), `<html data-theme>` following dreamcontext.
- Links to other sites open in the default browser; the window stays on the app.
- One window per app. Closing it stops the backend (unless an `apps do` or a schedule is running).
- Notifications use `dc.notify`, not the Web Notification API.
