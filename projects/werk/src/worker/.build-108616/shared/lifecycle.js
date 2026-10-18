/** Cleanup stages run in order; operations within a stage all settle before advancing. */
                                                           

export async function settleCleanup(...stages                                          )                {
  let failure                                   ;
  for (const stage of stages) {
    const steps = typeof stage === 'function' ? [stage] : stage;
    const results = await Promise.allSettled(steps.map(step => Promise.resolve().then(step)));
    failure ??= results.find((result)                                  => result.status === 'rejected');
  }
  if (failure) throw failure.reason;
}

/** A cleanup failure must not replace the error that caused startup or execution to fail. */
export async function withCleanup   (operation                  , cleanup             )             {
  let result   ;
  try { result = await operation(); }
  catch (error) {
    try { await cleanup(); } catch { /* Preserve the original operation failure. */ }
    throw error;
  }
  await cleanup();
  return result;
}
