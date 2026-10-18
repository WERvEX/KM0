import type { IpcChannel, IpcInput, ProjectDetail } from "@km0/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "@/lib/ipc";

export const projectKey = (id: number) => ["project.get", id] as const;

export function useProject(id: number) {
  return useQuery({ queryKey: projectKey(id), queryFn: () => call("project.get", { id }) });
}

/** Run a project action and put the returned detail straight into the cache. */
export function useProjectAction<C extends IpcChannel>(channel: C, projectId: number) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IpcInput<C>) => call(channel, input) as Promise<ProjectDetail>,
    onSuccess: (detail) => {
      queryClient.setQueryData(projectKey(projectId), detail);
      void queryClient.invalidateQueries({ queryKey: ["project.list"] });
      // A changed decision can make document sections stale.
      void queryClient.invalidateQueries({ queryKey: ["document.get", projectId] });
    },
    onError: () => {
      // A conflict means our view was stale; reload it.
      void queryClient.invalidateQueries({ queryKey: projectKey(projectId) });
    },
  });
}
