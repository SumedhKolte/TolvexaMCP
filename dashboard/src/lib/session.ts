import { useQuery } from "@tanstack/react-query";
import { api, ApiError, type User } from "./api";

/** The logged-in user, or null when there's no valid session. */
export function useMe() {
  return useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      try {
        return (await api<{ user: User }>("/api/me")).user;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) return null;
        throw err;
      }
    },
    staleTime: 30_000,
  });
}
