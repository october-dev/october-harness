# Trusted COW contract

This variant provides immutable copy-on-write revisions without recursive input validation or deep freezing.

- `track(initial)` and `prepareReplace(value)` take ownership. Inputs are alias-free, acyclic strict JSON made from dense arrays, plain data objects, finite numbers, strings, booleans, and `null`. Accessors, custom mutation hooks, symbols, classes, sparse arrays, and external proxies are outside the contract.
- Do not mutate transferred roots, `tracker.value`, `Prepared.base`, `Prepared.value`, or `Prepared.ops` externally. `Prepared.value` and `Prepared.ops` are independent immutable ownership transfers.
- Values assigned through a draft are cloned by value for each placement. Mutate transaction state only through its draft handles.
- Every change must settle exactly once through `prepare()` followed by `adopt()`, or through `abort()`. Draft handles are invalid after preparation or abortion.
- Array indices and mutator index arguments must be primitive numbers. Objects with coercion callbacks and mutations caused during argument coercion are outside the contract.
- Sort comparators must be synchronous and pure: they return ordinary numbers and do not mutate drafts, prepare transactions, or start nested operations.

Violating this contract is programmer error and may not be detected at runtime.
