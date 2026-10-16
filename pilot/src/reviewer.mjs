/**
 * The registry-admin environment requires a reviewer who is not the actor.
 * Approvers come only from the GitHub approvals API
 * (`GET /repos/{owner}/{repo}/actions/runs/{run_id}/approvals`).
 * An `APPROVERS` value is not an input. This check fails closed when that
 * list is missing or includes the person who triggered the run.
 */

/** Logins whose review state is `approved` on a workflow-run approvals payload. */
export function approvedReviewers(body) {
  if (!Array.isArray(body)) return [];
  return body
    .filter((item) => item?.state === "approved")
    .map((item) => item?.user?.login)
    .filter((login) => typeof login === "string" && login.length > 0);
}
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
