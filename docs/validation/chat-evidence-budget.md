# Ask Loop evidence packing

A live Mail question after #393 deployed returned the safe code INPUT_LIMIT_ABOVE_POLICY. No production message bodies or artifact sizes were exported.

A local regression supplies an oversized Mail overview alongside a small readable message. The previous packing loop removes the readable message before giving up on the oversized overview. The fix ranks direct Mail conversations ahead of summaries, omits individually oversized artifacts first, and reserves 500 estimated tokens for bounded repair instructions. Omitted sources remain explicit. No provider, permission, budget, or validation policy changes.

Validation: 18 focused question, gateway, and source tests pass; database typecheck passes. Production build result is recorded in the PR. This is local validation, not a successful live Mail answer.
