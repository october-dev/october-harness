# Astra trusted contract

Astra is an exact overlay tracker for trusted mutable live state. `track()` and
`prepareReplace()` take ownership of their roots in O(1); callers must not mutate
transferred roots except through an active Astra draft. Successful adoption
mutates the committed root in place, so previously retained committed references
observe later transactions.

Inputs and placements must already be alias-free strict JSON trees: plain objects,
dense arrays, strings, booleans, finite numbers, and `null`. Cycles, accessors,
proxies, symbols, classes, sparse arrays, `undefined`, and non-finite numbers are
outside the contract. Astra deliberately does not validate or freeze complete
input trees.

Supported draft operations use ordinary property access, primitive array indices,
and non-reentrant array callbacks. The following are outside the trusted contract:

- coercion callbacks that mutate the draft while an array method is converting an argument;
- mutations or `prepare()` calls from inside a `sort()` comparator;
- bigint or object-valued comparator results requiring coercion;
- non-primitive array indices.

These exclusions avoid callback-order and coercion machinery on the overlay hot
paths. Behavior for excluded operations is unspecified.
