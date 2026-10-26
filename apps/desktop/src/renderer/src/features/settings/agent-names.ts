import type { AgentId } from "@km0/shared";
import { useTranslation } from "react-i18next";
import { useIpcQuery } from "@/lib/queries";

/** Display names of agents by ID: the generic agent in the user's language, custom agents by their own name. */
export function useAgentNames(): (id: AgentId) => string {
  const { t } = useTranslation();
  const agents = useIpcQuery("settings.agents.list");
  return (id) => {
    if (id === "generic") return t("settings.agents.generic");
    return agents.data?.find((agent) => agent.id === id)?.name ?? id;
  };
}
