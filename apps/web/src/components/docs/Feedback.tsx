import { ExternalLink } from "@/components/ui";
import { editUrl, issueUrl } from "@/lib/docs/links";
import type { DocPage } from "@/lib/docs/types";
import d from "./docs.module.css";

/**
 * Phase 1 feedback: a prefilled GitHub issue and the edit link. The Yes/No control comes with
 * storage later.
 */
export function Feedback({ page, origin }: { page: DocPage; origin: string }) {
  return (
    <div className={d.feedback}>
      <span>Something wrong or missing on this page?</span>
      <ExternalLink href={issueUrl(page, origin)} className={d.link}>
        Report a problem on GitHub
      </ExternalLink>
      <ExternalLink href={editUrl(page)} className={d.link}>
        Edit this page
      </ExternalLink>
    </div>
  );
}
