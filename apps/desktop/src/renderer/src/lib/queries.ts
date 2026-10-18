import type { IpcChannel, IpcInput } from "@km0/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { call } from "./ipc";

/** Read a channel that takes no input. */
export function useIpcQuery<C extends IpcChannel>(channel: C) {
  return useQuery({ queryKey: [channel], queryFn: () => call(channel, undefined as IpcInput<C>) });
}

/** Call a channel and refresh the given queries afterwards. */
export function useIpcMutation<C extends IpcChannel>(channel: C, invalidates: IpcChannel[] = []) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: IpcInput<C>) => call(channel, input),
    onSuccess: async () => {
      await Promise.all(invalidates.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
    },
  });
}
