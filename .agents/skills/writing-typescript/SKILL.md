---
name: writing-typescript
description: Write, change, plan, or review TypeScript in the JA Painting repository. Use before work on .ts or .tsx files, including schemas, utilities, routes, and UI components.
---

# Writing TypeScript

Apply these rules with the root and package `AGENTS.md` files.

## Function arguments

Do not use a bare Boolean argument. Use a named options object so the call site
shows what the value means.

```ts
// Bad
func(name, true)

// Good
func({ name, isSomething: true })
```

## Code size

- Never disable max lines per function or file. Instead, refactor the code into utilities and components.

## Runtime schemas

Parse external data shapes at the system boundary. Do not pass unparsed external
data into application code.

For app-owned data, make the runtime schema the source of truth. Derive the
TypeScript type with `z.infer`. If that is not possible, add a compile-time
exactness check so the schema and type cannot drift.

## Indexed object types

- Do not disable `typescript/consistent-indexed-object-style`.
- Do not hide an unknown index signature behind a mapped type or a shared
  string-keyed record alias.
- Do not use `object` as a data shape or as the result of a record type guard.
  It does not describe the available fields.
- Do not use `Reflect.get` to read known fields from a broad type.
- Define named fields for known data. Parse external data with a runtime schema
  at the system boundary.
- For pass-through data, use a generic type so the caller keeps its exact type.
- Use `unknown` only at an input boundary. Parse it or convert it to a named
  output type before you pass it to application code.
- Use `Record<string, TValue>` only for a true map with a specific value type.
  Do not use `Record<string, unknown>`.

## Switch statements

- Prefer `switch` to an `if`/`else if` chain when one value has many named cases.
- Use a simple `if`/`else` for a two-way check.
- Do not use `switch` for `typeof`, `instanceof`, Booleans, or numbers.
- Include a `default` case that throws `UnreachableCaseError`.

```ts
// Good: switch over one value with many named cases.
switch (someVar) {
  case 'case-a': {
    return handleCaseA();
  }
  case 'case-b': {
    return handleCaseB();
  }
  case 'case-c': {
    return handleCaseC();
  }
  default: {
    throw new UnreachableCaseError(someVar);
  }
}

// Bad: switch over a Boolean. Use if/else.
switch (someBool) {
  case true: {
    return handleTrue();
  }
  case false: {
    return handleFalse();
  }
  default: {
    throw new UnreachableCaseError(someBool);
  }
}

// Bad: switch over typeof. Use an if check.
switch (typeof error) {
  case 'string': {
    return error;
  }
  default: {
    return null;
  }
}
```
