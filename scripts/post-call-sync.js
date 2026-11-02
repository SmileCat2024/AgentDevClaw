// Serialize completion-side projections without making them a call gate.
export function enqueueOrderedProjection(owner, key, work, onError) {
  owner[key] = owner[key]
    .then(work)
    .catch((error) => {
      onError(error);
    });
}
