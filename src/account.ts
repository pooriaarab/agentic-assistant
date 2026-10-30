import { PRINCIPAL_KINDS } from "agentic-identity";
import type { AccountPackage, AccountSubject } from "agentic-identity/account";

/** The assistant has no persistent account data and needs no storage dependency. */
export type AssistantAccount = AccountPackage<void>;

function checkSubject(subject: AccountSubject): void {
  if (typeof subject?.id !== "string" || subject.id.trim() === "" ||
      !(PRINCIPAL_KINDS as readonly unknown[]).includes(subject.kind)) {
    throw new TypeError("subject needs a non-empty id and a valid principal kind");
  }
}

/**
 * Account registry contributor for the stateless assistant runtime.
 * Messages, tool results, and provenance are returned to the host, never saved
 * here. Pending approvals exist only during a run. Stop active runs before an
 * account erase. Hosts must export and erase their own retained transcripts,
 * outputs, grants, history, and blobs through the packages that store them.
 * Empty records and counts mean this package has no persistent data; they do
 * not confirm that the host erased an account or stopped an active run.
 */
export const assistantAccount: AssistantAccount = {
  id: "assistant",
  async exportAccount(subject) {
    checkSubject(subject);
    return {};
  },
  async eraseAccount(subject) {
    checkSubject(subject);
    return {};
  },
};
