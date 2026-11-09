import { Rich } from "@/components/site/Rich";
import { AGENT_RULES } from "@/lib/docs/agents";
import d from "./docs.module.css";

export function AgentRules() {
  return (
    <ol className={d.rules}>
      {AGENT_RULES.map((rule) => (
        <li key={rule}>
          <Rich text={rule} />
        </li>
      ))}
    </ol>
  );
}
