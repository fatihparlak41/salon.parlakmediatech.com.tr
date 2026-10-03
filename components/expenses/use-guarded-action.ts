"use client";

import { startTransition, useActionState, useRef } from "react";
import type { ActionResult } from "@/lib/errors";

/**
 * Runs one Server Action for a dialog: pending state, the last result, an `onSuccess` callback, and a synchronous in-flight
 * guard. The guard is what makes a double-click (or two submit events in the same tick, before React re-renders the button
 * as disabled) send exactly ONE request. `run` returns false when it ignored the call.
 */
export function useGuardedAction<Input, Data>(
  action: (
    prevState: ActionResult<Data> | null,
    input: Input,
  ) => Promise<ActionResult<Data>>,
  onSuccess: (data: Data) => void,
) {
  const inFlight = useRef(false);

  const [state, dispatch, isPending] = useActionState(
    async (prevState: ActionResult<Data> | null, input: Input) => {
      try {
        const result = await action(prevState, input);
        if (result.success) onSuccess(result.data);
        return result;
      } finally {
        inFlight.current = false;
      }
    },
    null,
  );

  function run(input: Input): boolean {
    if (inFlight.current) return false;
    inFlight.current = true;
    startTransition(() => dispatch(input));
    return true;
  }

  return { state, run, isPending };
}
