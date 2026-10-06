"use client";

import { startTransition, useActionState, useRef } from "react";
import { fail, type ActionResult } from "@/lib/errors";
import { EXPENSE_DEFAULT_ERROR_MESSAGE } from "@/lib/modules/expenses/error-codes";

/**
 * Runs one Server Action for a dialog: pending state, the last result, an `onSuccess` callback, and a synchronous in-flight
 * guard. The guard is what makes a double-click (or two submit events in the same tick, before React re-renders the button
 * as disabled) send exactly ONE request. `run` returns false when it ignored the call.
 *
 * A call that REJECTS (a dropped connection, an aborted request, a crashed server render) is reported as an ordinary failed
 * result. Nothing is known about whether the server ran it, and an uncaught rejection is rethrown by useActionState into the
 * page's error boundary, which replaces the whole page and destroys the dialog together with its idempotency key. With the
 * dialog still mounted the retry sends the identical key and payload, and create and payment answer it with the original
 * result instead of a duplicate. An error thrown by `onSuccess` is NOT swallowed.
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
        let result: ActionResult<Data>;
        try {
          result = await action(prevState, input);
        } catch {
          return fail<Data>("UNEXPECTED", EXPENSE_DEFAULT_ERROR_MESSAGE);
        }
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
