# Decisions

## Feature Prioritization
Generally I look at things as a user value and implementation complexity pairing and find things that have the highest value and lowest complexity.

Timeout was trivial to add otherwise I thought these were high value and low enough complexity and would make for a good V1
- Rate limiting - Prevents abuse and overloading API endpoints
- Auth - Not as common but a requirement to work for some routes
- Retry - Better end user experience
- Load balancing (if I had to cut something I would cut this) - Smooth out traffic for the user

## Architecture Choices and Tradeoffs
- Load config on startup, sacrifice hot reloading for less implementation complexity
- Use port from yaml file rather than the core requirement of "listening on port 8080", I'm assuming that means read from config as the provided one is 8080
- Use node http server since we'll get limited benefits from something like express/hono, you have to write more code but get better control and performance
- Route matching is longest match wins first, startup error on duplicate (route, method) combination in configuration
- Middleware pipeline for config options to make it easy to add new features

Rate limit
- Full override of config, partial override can have tricky edge cases
- No way to opt out of global config e.g. `rate_limit: false`
- The global rate limit is per route definition vs across many routes

Retry
- Retry also includes connection errors
- Will retry all methods including POST, this can have serious side effects but it's per users request. Can be a footgun, might be better to warn the user on startup.

Load Balancing
- Smooth weighted round robin formula, it's not random but it's deterministic
- Reject startup config with round robin + weights (invalid setup)

Open questions:
- OPTIONS method - Should we support this if it's not proxied
- health endpoint conflict - ignored today, should likely crash on startup
- Case sensitivity on routes/methods - currently case sensitive, likely should not be

## What you'd build next with more time

- Add "not supported yet" startup failures for unsupported config options

What I would build in order:
- Basic header transforms
- Header transforms with variables
- Body transforms
- Circuit breaker

## How you used AI tools

I treat AI as a brainstorming partner where we work together to figure out the right plan of action then I have AI implement it and then I do a sanity check after.

Generally I try to invest in systems that allow me to be more hands off and come in for critical parts/direction. Any mistakes made by AI should be encoded into the system.