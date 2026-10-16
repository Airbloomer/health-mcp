/**
 * The registry-admin environment requires a reviewer who is not the actor.
 * GitHub's prevent-self-review setting is the platform gate; this check fails closed
 * when the recorded approvers are missing or include the person who triggered the run.
 */
export function assertDistinctReviewer({ actor, approvers, policy }) {
  if (!policy?.prevent_self_review || !policy?.required_reviewers) {
    throw new Error("registry-admin must require a reviewer other than the person who triggered the run");
  }
  if (!actor) throw new Error("triggering actor is required");
  if (!Array.isArray(approvers) || approvers.length === 0) {
    throw new Error("a required reviewer must approve the run");
  }
  if (approvers.some((login) => login === actor)) {
    throw new Error("reviewer must not be the person who triggered the run");
  }
}
