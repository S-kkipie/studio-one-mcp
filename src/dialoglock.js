// One Studio One dialog flow at a time (preset file dialogs, the export dialog): two of them at
// once could press keys in each other's dialog or snapshot each other's windows. Separate from the
// plug-in controller's serialized() queue, so a caller that already holds that queue cannot
// deadlock against this one.
let dialogQueue = Promise.resolve();
export function withDialogLock(fn) {
  const p = dialogQueue.then(fn, fn);
  dialogQueue = p.catch(() => {});
  return p;
}
