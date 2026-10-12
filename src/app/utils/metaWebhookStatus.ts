/** Process independent message IDs concurrently, retaining order for each message. */
export async function processMetaStatusBatch(
  values: any[],
  handleStatus: (status: any) => Promise<unknown>,
): Promise<void> {
  const grouped = new Map<string, any[]>();
  for (const value of values) {
    for (const status of value.statuses || []) {
      const group = grouped.get(status.id) || [];
      group.push(status);
      grouped.set(status.id, group);
    }
  }
  const groups = [...grouped.values()];
  let nextGroup = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(5, groups.length) }, async () => {
    while (nextGroup < groups.length) {
      const group = groups[nextGroup++];
      for (const status of group) await handleStatus(status);
    }
  }));
  // Wait for in-flight writes before reporting a failure so a retry cannot race unfinished work.
  const failed = results.find(result => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
