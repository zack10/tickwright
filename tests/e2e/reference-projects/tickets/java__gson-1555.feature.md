# Add isEmpty() to JsonArray and JsonObject

Checking whether a `JsonArray` or a `JsonObject` has no elements today means writing `array.size() == 0` or `object.size() == 0`, which reads worse than the `isEmpty()` that Java collections offer.

Please add a public `isEmpty()` method to both classes:

- `JsonArray.isEmpty()` returns `true` when the array has no elements, `false` otherwise.
- `JsonObject.isEmpty()` returns `true` when the object has no members, `false` otherwise.

Examples:

- `new JsonArray().isEmpty()` is `true`; after `add(1)` it is `false`; after removing that element again it is `true`.
- `new JsonObject().isEmpty()` is `true`; after `addProperty("a", 1)` it is `false`; after `remove("a")` it is `true`.

Keep the existing methods unchanged. Add tests for the new methods next to the existing tests for these classes.
