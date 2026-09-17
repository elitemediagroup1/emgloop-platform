// Small shared shapes for the runner. Slice B6.

/** A job's stored input, as the store returns it: scalars only. */
export type BrainTaskInputView = Readonly<Record<string, string | number | boolean | null>>;
