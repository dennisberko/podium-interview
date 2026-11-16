- Load config on startup, sacrifice hot reloading for less implementation complexity- Listen port comes from `gateway.port` (8080 in the example) so a different config can move it
- Use port from yaml file rather than the core requirement of "listening on port 8080", I'm assuming that means read from config as the provided one is 8080
- Use node http server since we'll get limited benefits from something like express/hono
- Route matching is longest match wins first, startup error on duplicate (route, method) combination in configuration
- Middleware pipeline for config options to make it easy to add new features

Open questions:
- OPTIONS method?
- health endpoint conflict - ignored today, should likely crash on startup
- Case sensitivity on routes/methods - currently case sensitive, likely should not be